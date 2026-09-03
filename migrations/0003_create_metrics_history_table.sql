-- Migration number: 0003 	 2026-09-02T00:00:00.000Z
CREATE TABLE IF NOT EXISTS METRICS_HISTORY (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    METRIC_NAME VARCHAR(50) NOT NULL,
    POOL_ID VARCHAR(30) NOT NULL,
    DIMENSION_NAME VARCHAR(30),
    DIMENSION_VALUE VARCHAR(30),
    VALUE INTEGER NOT NULL,
    RECORDED_AT DATETIME NOT NULL
);

-- Dashboard reads filter only by RECORDED_AT; a composite index would not be
-- used for that query (no leftmost-prefix match) and D1 bills by rows read.
CREATE INDEX IF NOT EXISTS idx_metrics_recorded_at ON METRICS_HISTORY (RECORDED_AT);
