// src/ssf_day_snapshot.ts
// Latest session snapshot of a single pool for one or more (pool-local) dates.
// Each date is cached in KV once it is over, since past history does not change.
// All dates/times are handled as plain strings - no timezone conversions.

const MAX_DATES = 31;
const SETTLE_HOURS = 12;
const CACHE_TTL_SECONDS = 7 * 24 * 3600;

export async function daySnapshot(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const poolId = url.searchParams.get('poolid') || '';
	// yyyy-mm-dd list, deduped and sorted (string sort is chronological for this format)
	const dates = [...new Set((url.searchParams.get('dates') || '').split(',').map(d => d.trim()).filter(Boolean))].sort();

	if (!poolId || poolId.length > 30 || dates.length === 0 || dates.length > MAX_DATES
		|| dates.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
		return new Response(JSON.stringify({
			success: false,
			error: `Use ?poolid=xxx&dates=yyyy-mm-dd[,yyyy-mm-dd...] (max ${MAX_DATES} dates)`
		}), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}

	const cacheKey = (date: string) => `day-snapshot:v1:${poolId}:${date}`;
	// yyyy-mm-dd -> dd-mm-yyyy (SESSION_DATE storage format)
	const toSessionDate = (date: string) => date.split('-').reverse().join('-');

	const cached: (string | null)[] = await Promise.all(dates.map(d => env.SNAPSHOT_CACHE.get(cacheKey(d))));
	const rowsByDate: Record<string, any[]> = {};
	dates.forEach((d, i) => {
		if (cached[i] !== null) rowsByDate[d] = JSON.parse(cached[i]!);
	});

	const missedDates = dates.filter(d => !rowsByDate[d]);
	if (missedDates.length > 0) {
		// With a single MAX() aggregate, SQLite takes the bare columns from the row
		// holding the max, so every column comes from each session's latest scrape.
		const query = `
SELECT POOL_ID, MAX(UPDATED_AT) AS UPDATED_AT, SESSION_DATE, SESSION_TIME, SESSION_DATETIME,
       SESSION_TITLE, SESSION_SIDE, AVAILABLE_SPOTS, AREA
FROM SESSIONS_SCHEDULE_HISTORY
WHERE POOL_ID = ? AND SESSION_DATE IN (${missedDates.map(() => '?').join(', ')})
GROUP BY SESSION_DATE, SESSION_DATETIME, SESSION_TITLE, SESSION_SIDE
ORDER BY SESSION_DATETIME, SESSION_SIDE, SESSION_TITLE
		`;

		let results: any[];
		try {
			({ results } = await env.DB.prepare(query).bind(poolId, ...missedDates.map(toSessionDate)).all());
		} catch (error) {
			return new Response(JSON.stringify({ success: false, error: String(error) }), {
				status: 500,
				headers: { "content-type": "application/json" },
			});
		}

		// UTC "now - SETTLE_HOURS" in SESSION_DATETIME's format (yyyy-mm-ddTHH:MM:SS)
		const settledBefore = new Date(Date.now() - SETTLE_HOURS * 3600 * 1000).toISOString().slice(0, 19);

		for (const date of missedDates) {
			const sessionDate = toSessionDate(date);
			const rows = results.filter(r => r.SESSION_DATE === sessionDate);
			rowsByDate[date] = rows;

			// Cache only once the date's last session is well in the past (and not empty)
			const lastSessionDateTime = rows.length > 0 ? rows[rows.length - 1].SESSION_DATETIME : null;
			if (lastSessionDateTime && lastSessionDateTime <= settledBefore) {
				ctx.waitUntil(env.SNAPSHOT_CACHE.put(cacheKey(date), JSON.stringify(rows), { expirationTtl: CACHE_TTL_SECONDS }));
			}
		}
	}

	return new Response(JSON.stringify(dates.flatMap(d => rowsByDate[d])), {
		headers: {
			"content-type": "application/json",
			"access-control-allow-origin": "*",
		},
	});
}
