// src/ssf_spots_available_heatmap.ts
// Spots-available statistics of a single pool over a date range, per weekday x time slot
// (broken down by title and side, so clients can filter levels without re-querying).
// "Spots available" means the session's latest scrape showed AVAILABLE_SPOTS > 0.
// Built from the day-snapshot rows (KV cached per day); the result is cached in KV per input values.
// All dates/times are handled as plain strings - no timezone conversions.

import { getDayRows, MAX_DATES } from "./ssf_day_snapshot";

// A range whose last date is settled never changes; otherwise recompute soon.
// Clients ask for the last 3 full months, so a settled range is requested for one
// whole month - keep it a bit longer than any month.
const STATS_TTL_SETTLED_SECONDS = 35 * 24 * 3600;
const STATS_TTL_OPEN_SECONDS = 3600;

// yyyy-mm-dd dates from..to inclusive (UTC only as calendar arithmetic)
function dateRange(from: string, to: string): string[] {
	const dates: string[] = [];
	for (let d = new Date(from + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
		dates.push(d.toISOString().slice(0, 10));
	}
	return dates;
}

export async function spotsAvailableHeatmap(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const poolId = url.searchParams.get('poolid') || '';
	const from = url.searchParams.get('from') || '';
	const to = url.searchParams.get('to') || '';
	const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
	const dates = isDate(from) && isDate(to) && from <= to ? dateRange(from, to) : [];

	if (!poolId || poolId.length > 30 || dates.length === 0 || dates.length > MAX_DATES) {
		return new Response(JSON.stringify({
			success: false,
			error: `Use ?poolid=xxx&from=yyyy-mm-dd&to=yyyy-mm-dd[&refresh=1] (max ${MAX_DATES} dates)`
		}), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}

	const headers = { "content-type": "application/json", "access-control-allow-origin": "*" };
	const cacheKey = `spots-available-heatmap:v1:${poolId}:${from}:${to}`;

	// ?refresh=1 recomputes the statistics (day rows still come from their own cache)
	if (url.searchParams.get('refresh') !== '1') {
		const cached = await env.SSF_HISOTRY_SNAPSHOT_CACHE.get(cacheKey);
		if (cached !== null) return new Response(cached, { headers: { ...headers, "x-stats-cache": "HIT" } });
	}

	let rowsByDate: Record<string, any[]>, settledDates: Set<string>;
	try {
		({ rowsByDate, settledDates } = await getDayRows(env, ctx, poolId, dates));
	} catch (error) {
		return new Response(JSON.stringify({ success: false, error: String(error) }), {
			status: 500,
			headers: { "content-type": "application/json" },
		});
	}

	const cells = new Map<string, { weekday: number, time: string, title: string, side: string, sessions: number, spotsAvailable: number, days: number }>();
	const lastDateByKey = new Map<string, string>();
	for (const date of dates) {
		const weekday = new Date(date + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
		for (const row of rowsByDate[date]) {
			const key = `${weekday}|${row.SESSION_TIME}|${row.SESSION_TITLE}|${row.SESSION_SIDE}`;
			let cell = cells.get(key);
			if (!cell) {
				cell = { weekday, time: row.SESSION_TIME, title: row.SESSION_TITLE, side: row.SESSION_SIDE, sessions: 0, spotsAvailable: 0, days: 0 };
				cells.set(key, cell);
			}
			cell.sessions++;
			if (row.AVAILABLE_SPOTS > 0) cell.spotsAvailable++;
			// days = distinct dates the cell had sessions on
			if (lastDateByKey.get(key) !== date) {
				lastDateByKey.set(key, date);
				cell.days++;
			}
		}
	}

	const body = JSON.stringify({
		poolId,
		from,
		to,
		dates: dates.length,
		datesWithData: dates.filter(d => rowsByDate[d].length > 0).length,
		cells: [...cells.values()].sort((a, b) => a.weekday - b.weekday || a.time.localeCompare(b.time)
			|| a.title.localeCompare(b.title) || a.side.localeCompare(b.side)),
	});

	const ttl = settledDates.has(to) ? STATS_TTL_SETTLED_SECONDS : STATS_TTL_OPEN_SECONDS;
	ctx.waitUntil(env.SSF_HISOTRY_SNAPSHOT_CACHE.put(cacheKey, body, { expirationTtl: ttl }));

	return new Response(body, { headers: { ...headers, "x-stats-cache": "MISS" } });
}
