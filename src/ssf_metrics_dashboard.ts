// src/ssf_metrics_dashboard.ts
// Ingestion, query, and dashboard rendering for the RailwayApp metrics
// (replaces the paid CloudWatch dashboard that used to display these).

interface MetricRow {
	metric_name: string;
	pool_id: string;
	dimension_name?: string | null;
	dimension_value?: string | null;
	value: number;
	recorded_at: string;
}

const MAX_HOURS = 24 * 28; // 4 weeks
const DEFAULT_HOURS = 168; // 1 week, matches the widest CloudWatch preset button
const RETENTION_MONTHS = 12;

export async function ingestMetrics(request: Request, env: any): Promise<Response> {
	const key = request.headers.get("X-Metrics-Key");
	if (!key || key !== env.METRICS_INGEST_KEY) {
		return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
			status: 401,
			headers: { "content-type": "application/json" },
		});
	}

	try {
		const body = (await request.json()) as MetricRow[];

		if (!Array.isArray(body)) {
			return new Response(JSON.stringify({ success: false, error: "Request body must be an array" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}

		if (body.length === 0) {
			return new Response(JSON.stringify({ success: false, error: "Array cannot be empty" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}

		if (body.length > 1000) {
			return new Response(JSON.stringify({ success: false, error: "Maximum 1000 items allowed per request" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}

		const statements = body.map(row => {
			return env.DB.prepare(`
				INSERT INTO METRICS_HISTORY
				(METRIC_NAME, POOL_ID, DIMENSION_NAME, DIMENSION_VALUE, VALUE, RECORDED_AT)
				VALUES (?, ?, ?, ?, ?, ?)
			`).bind(
				row.metric_name,
				row.pool_id,
				row.dimension_name || null,
				row.dimension_value || null,
				row.value,
				row.recorded_at
			);
		});

		// Prune rows past the retention window as part of the same batch, so
		// cleanup rides along with each ingest call and needs no separate schedule.
		const retentionCutoff = new Date();
		retentionCutoff.setMonth(retentionCutoff.getMonth() - RETENTION_MONTHS);
		statements.push(
			env.DB.prepare(`DELETE FROM METRICS_HISTORY WHERE RECORDED_AT < ?`).bind(retentionCutoff.toISOString())
		);

		const results = await env.DB.batch(statements);

		return new Response(JSON.stringify({ success: true, inserted: body.length, results }), {
			status: 201,
			headers: { "content-type": "application/json" },
		});
	} catch (error) {
		return new Response(JSON.stringify({ success: false, error: String(error) }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}
}

export async function getMetricsData(request: Request, env: any): Promise<Response> {
	const url = new URL(request.url);
	const hoursParam = parseInt(url.searchParams.get("hours") || String(DEFAULT_HOURS), 10);
	const hours = Math.max(1, Math.min(MAX_HOURS, isNaN(hoursParam) ? DEFAULT_HOURS : hoursParam));
	const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();

	const stmt = env.DB.prepare(`
		SELECT METRIC_NAME, POOL_ID, DIMENSION_NAME, DIMENSION_VALUE, VALUE, RECORDED_AT
		FROM METRICS_HISTORY
		WHERE RECORDED_AT >= ?
		ORDER BY RECORDED_AT ASC
	`).bind(cutoff);
	const { results } = await stmt.all();

	return new Response(JSON.stringify(results), {
		headers: { "content-type": "application/json" },
	});
}

// One tile per widget kept from the CloudWatch dashboard (the AWS/SES Send/Open
// widget is dropped - that's native SES data, not something we compute).
const WIDGETS: { title: string; metric: string; dimensionValue?: string }[] = [
	{ title: "Session count (rolling 24h) by pool", metric: "SessionCount" },
	{ title: "Preferences — active", metric: "UserPreferences", dimensionValue: "1" },
	{ title: "Sent emails (rolling 24h) by pool", metric: "SentNotifications", dimensionValue: "EMAIL" },
	{ title: "Email verifications (rolling 24h) by pool", metric: "EmailVerifications" },
	{ title: "Unique users (all-time) by pool", metric: "TotalUniqueUsers" },
	{ title: "Preferences — inactive", metric: "UserPreferences", dimensionValue: "0" },
	{ title: "Sent FCM pushes (rolling 24h) by pool", metric: "SentNotifications", dimensionValue: "FCM" },
	{ title: "URL redirects (rolling 24h) by pool", metric: "RedirectedClick" },
];

const TIME_RANGES: { label: string; hours: number }[] = [
	{ label: "1h", hours: 1 },
	{ label: "3h", hours: 3 },
	{ label: "12h", hours: 12 },
	{ label: "1d", hours: 24 },
	{ label: "3d", hours: 72 },
	{ label: "1w", hours: 168 },
];

export async function renderMetricsDashboard(): Promise<Response> {
	const tiles = WIDGETS.map(w => `
		<div class="tile">
			<h2>${w.title}</h2>
			<canvas data-metric="${w.metric}" data-dimension-value="${w.dimensionValue ?? ""}"></canvas>
		</div>
	`).join("");

	const rangeButtons = TIME_RANGES.map(r => `
		<button type="button" class="range-btn${r.hours === DEFAULT_HOURS ? " active" : ""}" data-hours="${r.hours}">${r.label}</button>
	`).join("");

	const html = `
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>SSF Metrics Dashboard</title>
	<style>
		:root {
			--surface-1: #1a1a19;
			--page-plane: #0d0d0d;
			--text-primary: #ffffff;
			--text-secondary: #c3c2b7;
			--text-muted: #898781;
			--gridline: #2c2c2a;
			--border: rgba(255, 255, 255, 0.10);
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			padding: 24px;
			background: var(--page-plane);
			color: var(--text-primary);
			font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
		}
		h1 { font-size: 1.3em; margin: 0 0 16px; }
		.ranges { display: flex; gap: 8px; margin-bottom: 20px; }
		.range-btn {
			background: var(--surface-1);
			color: var(--text-secondary);
			border: 1px solid var(--border);
			border-radius: 6px;
			padding: 6px 14px;
			font-size: 0.9em;
			cursor: pointer;
		}
		.range-btn.active { color: var(--text-primary); border-color: var(--text-secondary); }
		.grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
			gap: 20px;
			transition: opacity 0.15s ease;
		}
		.grid.loading { opacity: 0.5; }
		.tile {
			background: var(--surface-1);
			border: 1px solid var(--border);
			border-radius: 8px;
			padding: 16px;
		}
		.tile h2 {
			font-size: 0.95em;
			font-weight: 600;
			color: var(--text-secondary);
			margin: 0 0 12px;
		}
		canvas { width: 100% !important; height: 260px !important; }
	</style>
	<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
	<script defer src="/metrics_dashboard_client.js"></script>
</head>
<body>
	<h1>SSF Metrics Dashboard</h1>
	<div class="ranges" id="ranges">${rangeButtons}</div>
	<div class="grid" id="grid">${tiles}</div>
</body>
</html>
`;

	return new Response(html, {
		headers: { "content-type": "text/html" },
	});
}
