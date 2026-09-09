-- Migration number: 0004 	 2026-09-08T00:00:00.000Z
--
-- SESSIONS_SCHEDULE_HISTORY has had zero indexes since it was created
-- (migration 0002). Two read paths were doing full-table scans that grow
-- more expensive every day as the table accumulates history:
--
--   1. GET /api/sessions: `ORDER BY SESSION_DATETIME DESC LIMIT 1000` with
--      no WHERE clause -- D1 has to scan+sort the entire table to find the
--      newest 1000 rows.
--   2. GET /api/ssf-seo-post-content/dates-vacancies (src/ssf_seo_input_for_posts.ts):
--      the FilteredLatestRecords CTE joins the *whole* table against the
--      LatestSessionUpdates CTE on (POOL_ID, SESSION_DATETIME,
--      SESSION_TITLE, SESSION_SIDE, UPDATED_AT) with no filter on the join
--      side -- this is the query that exceeded the D1 free-tier daily row
--      read limit.
--
-- idx_ssh_pool_dt_title_side_updated matches that 5-column join exactly
-- (leftmost-prefix), turning it from a full scan into index lookups.
-- idx_ssh_pool_date covers the LatestSessionUpdates CTE's
-- `WHERE POOL_ID = ? AND SESSION_DATE IN (...)` filter.
-- idx_ssh_session_datetime covers the /api/sessions ORDER BY so it can
-- walk the index instead of sorting the full table.
CREATE INDEX IF NOT EXISTS idx_ssh_pool_dt_title_side_updated
    ON SESSIONS_SCHEDULE_HISTORY (POOL_ID, SESSION_DATETIME, SESSION_TITLE, SESSION_SIDE, UPDATED_AT);

CREATE INDEX IF NOT EXISTS idx_ssh_pool_date
    ON SESSIONS_SCHEDULE_HISTORY (POOL_ID, SESSION_DATE);

CREATE INDEX IF NOT EXISTS idx_ssh_session_datetime
    ON SESSIONS_SCHEDULE_HISTORY (SESSION_DATETIME);
