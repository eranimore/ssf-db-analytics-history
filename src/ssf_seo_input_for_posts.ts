// src/ssf_seo_input_for_posts.ts
// Module for serving SEO content queries for post generation

export async function seoContentForDatesHighlights(request: Request, env: any): Promise<Response> {
	// Get date range from query parameters (format: yyyy-mm-dd)
	const url = new URL(request.url);
	const fromDateParam = url.searchParams.get('fromdate') || '';
	const untilDateParam = url.searchParams.get('untildate') || '';
	const poolIdParam = url.searchParams.get('poolid') || '';
	const topXRecordsParam = url.searchParams.get('topxrecords') || '3';
	
	if (!fromDateParam || !untilDateParam || !poolIdParam) {
		return new Response(JSON.stringify({ 
			success: false, 
			error: 'Missing required parameters.' //  Use ?fromdate=yyyy-mm-dd&untildate=yyyy-mm-dd&poolid=xxx' 
		}), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}
	
	// Parse dates
	const fromDate = new Date(fromDateParam);
	const untilDate = new Date(untilDateParam);
	
	if (isNaN(fromDate.getTime()) || isNaN(untilDate.getTime())) {
		return new Response(JSON.stringify({ 
			success: false, 
			error: 'Invalid date format. Use yyyy-mm-dd' 
		}), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}
	
	if (fromDate > untilDate) {
		return new Response(JSON.stringify({ 
			success: false, 
			error: 'fromdate must be before or equal to untildate' 
		}), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}
	
	// Parse and validate topXrecords
	const topXRecords = Math.max(1, parseInt(topXRecordsParam, 10) || 10);
	
	// Generate array of dates in dd-mm-yyyy format
	const dates: string[] = [];
	const currentDate = new Date(fromDate);
	
	while (currentDate <= untilDate) {
		const day = String(currentDate.getDate()).padStart(2, '0');
		const month = String(currentDate.getMonth() + 1).padStart(2, '0');
		const year = currentDate.getFullYear();
		dates.push(`${day}-${month}-${year}`);
		currentDate.setDate(currentDate.getDate() + 1);
	}
	
	// Build the IN clause with parameterized placeholders
	const placeholders = dates.map(() => '?').join(', ');
	
	const query = `
WITH LatestSessionUpdates AS (
  SELECT 
    POOL_ID,
    SESSION_DATETIME,
    SESSION_TITLE,
    SESSION_SIDE,
    MAX(UPDATED_AT) AS LatestUpdatedAt
  FROM SESSIONS_SCHEDULE_HISTORY
  WHERE SESSION_DATE IN (${placeholders})
    AND POOL_ID = ?
    AND SESSION_TITLE NOT LIKE '%Beginner%'
    AND SESSION_TITLE NOT LIKE '%מתחיל%'
    AND SESSION_TITLE NOT LIKE '%Coach%'
  GROUP BY POOL_ID, SESSION_DATETIME, SESSION_TITLE, SESSION_SIDE
),
FilteredLatestRecords AS (
  SELECT h.*
  FROM SESSIONS_SCHEDULE_HISTORY h
  JOIN LatestSessionUpdates l
    ON h.POOL_ID = l.POOL_ID
    AND h.SESSION_DATETIME = l.SESSION_DATETIME
    AND h.SESSION_TITLE = l.SESSION_TITLE
    AND h.SESSION_SIDE = l.SESSION_SIDE
    AND h.UPDATED_AT = l.LatestUpdatedAt
),
RankedRecords AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY POOL_ID
      ORDER BY 
        AVAILABLE_SPOTS DESC,
        UPDATED_AT DESC
    ) AS rn
  FROM FilteredLatestRecords
)
SELECT *
FROM RankedRecords
WHERE rn <= ?
ORDER BY 
  POOL_ID,
  SESSION_DATETIME DESC,
  AVAILABLE_SPOTS DESC
	`;

	try {
		// Build bind parameters array: dates, pool_id, topXRecords
		const bindParams = [...dates, poolIdParam, String(topXRecords)];
		
		const stmt = env.DB.prepare(query).bind(...bindParams);
		const { results } = await stmt.all();
		
		return new Response(JSON.stringify(results, null, 2), {
			headers: { "content-type": "application/json" },
		});
	} catch (error) {
		return new Response(JSON.stringify({ 
			success: false, 
			error: String(error) 
		}), {
			status: 500,
			headers: { "content-type": "application/json" },
		});
	}
}
