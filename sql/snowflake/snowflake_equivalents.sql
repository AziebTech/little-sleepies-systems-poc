-- =====================================================================================
-- Snowflake equivalents of the Postgres POC objects and queries.
-- Not executed in the POC (no free Snowflake tier beyond the 30-day trial). Its purpose
-- is to show I know the dialect and the operational surface: warehouses, Snowpipe,
-- streams/tasks, QUALIFY, VARIANT, and ACCOUNT_USAGE monitoring.
-- =====================================================================================

-- ------------------------------------------------------------------ 1. Objects
CREATE DATABASE IF NOT EXISTS LS_OPS;
CREATE SCHEMA  IF NOT EXISTS LS_OPS.AUDIT;
CREATE SCHEMA  IF NOT EXISTS LS_OPS.ANALYTICS;

-- Small warehouse that suspends quickly: monitoring queries are tiny and bursty.
CREATE WAREHOUSE IF NOT EXISTS OPS_XS_WH
  WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60 AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE;

CREATE TABLE IF NOT EXISTS LS_OPS.AUDIT.SYNC_AUDIT_LOGS (
    LOG_ID         NUMBER AUTOINCREMENT,
    EXECUTION_ID   STRING,
    WORKFLOW_NAME  STRING,
    SOURCE_SYSTEM  STRING NOT NULL,
    TARGET_SYSTEM  STRING NOT NULL,
    ENTITY_TYPE    STRING NOT NULL,
    ENTITY_ID      STRING,
    SKU            STRING,
    ACTION         STRING NOT NULL,
    STATUS         STRING NOT NULL,
    HTTP_STATUS    NUMBER,
    ERROR_MESSAGE  STRING,
    APPROVED_AT    TIMESTAMP_TZ,
    PAYLOAD        VARIANT,                      -- semi-structured JSON, queried with PAYLOAD:style_id::string
    CREATED_AT     TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP()
);

-- ------------------------------------------------------------------ 2. Loading options
-- (a) n8n has a Snowflake node: INSERT directly (fine at this volume).
-- (b) At scale: n8n writes NDJSON to S3 → Snowpipe auto-ingest.
CREATE STAGE IF NOT EXISTS LS_OPS.AUDIT.SYNC_LOGS_STAGE
  URL = 's3://ls-ops-landing/sync-logs/'
  STORAGE_INTEGRATION = LS_S3_INT
  FILE_FORMAT = (TYPE = JSON STRIP_OUTER_ARRAY = TRUE);

CREATE PIPE IF NOT EXISTS LS_OPS.AUDIT.SYNC_LOGS_PIPE AUTO_INGEST = TRUE AS
  COPY INTO LS_OPS.AUDIT.SYNC_AUDIT_LOGS (EXECUTION_ID, WORKFLOW_NAME, SOURCE_SYSTEM, TARGET_SYSTEM, ENTITY_TYPE,
                                          ENTITY_ID, SKU, ACTION, STATUS, HTTP_STATUS, ERROR_MESSAGE, APPROVED_AT, PAYLOAD)
  FROM (SELECT $1:execution_id, $1:workflow_name, $1:source_system, $1:target_system, $1:entity_type,
               $1:entity_id, $1:sku, $1:action, $1:status, $1:http_status, $1:error_message,
               $1:approved_at::TIMESTAMP_TZ, $1:payload
        FROM @LS_OPS.AUDIT.SYNC_LOGS_STAGE);

-- ------------------------------------------------------------------ 3. Analytics (dialect differences)
-- Latest attempt per record: QUALIFY replaces the ROW_NUMBER() subquery used in Postgres.
SELECT ENTITY_ID, SKU, STATUS, HTTP_STATUS, ERROR_MESSAGE, CREATED_AT
FROM LS_OPS.AUDIT.SYNC_AUDIT_LOGS
WHERE ENTITY_TYPE = 'item'
QUALIFY ROW_NUMBER() OVER (PARTITION BY ENTITY_ID ORDER BY CREATED_AT DESC) = 1
    AND STATUS = 'failed';

-- Daily error rate: COUNT_IF / DIV0 instead of FILTER / NULLIF.
SELECT DATE_TRUNC('day', CREATED_AT)::DATE                     AS DAY,
       COUNT(*)                                                AS ATTEMPTS,
       COUNT_IF(STATUS = 'failed')                             AS FAILURES,
       ROUND(100 * DIV0(COUNT_IF(STATUS = 'failed'), COUNT(*)), 1) AS ERROR_RATE_PCT
FROM LS_OPS.AUDIT.SYNC_AUDIT_LOGS
WHERE CREATED_AT >= DATEADD('day', -30, CURRENT_TIMESTAMP())
GROUP BY 1
ORDER BY 1 DESC;

-- Approval → ERP latency: DATEDIFF + APPROX_PERCENTILE (cheap on large tables).
WITH FIRST_SUCCESS AS (
    SELECT ENTITY_ID, MIN(APPROVED_AT) AS APPROVED_AT, MIN(CREATED_AT) AS LIVE_AT
    FROM LS_OPS.AUDIT.SYNC_AUDIT_LOGS
    WHERE STATUS = 'success' AND APPROVED_AT IS NOT NULL
    GROUP BY ENTITY_ID
)
SELECT COUNT(*)                                                     AS SKUS,
       AVG(DATEDIFF('minute', APPROVED_AT, LIVE_AT))                 AS AVG_MINUTES,
       APPROX_PERCENTILE(DATEDIFF('minute', APPROVED_AT, LIVE_AT), 0.5)  AS P50_MINUTES,
       APPROX_PERCENTILE(DATEDIFF('minute', APPROVED_AT, LIVE_AT), 0.95) AS P95_MINUTES
FROM FIRST_SUCCESS;

-- VARIANT access.
SELECT PAYLOAD:style_id::STRING AS STYLE_ID, PAYLOAD:category::STRING AS ERROR_CATEGORY, COUNT(*)
FROM LS_OPS.AUDIT.SYNC_AUDIT_LOGS
WHERE STATUS = 'failed'
GROUP BY 1, 2;

-- ------------------------------------------------------------------ 4. Incremental processing: stream + task
CREATE STREAM IF NOT EXISTS LS_OPS.AUDIT.SYNC_LOGS_STREAM ON TABLE LS_OPS.AUDIT.SYNC_AUDIT_LOGS APPEND_ONLY = TRUE;

CREATE TABLE IF NOT EXISTS LS_OPS.ANALYTICS.SYNC_DAILY (DAY DATE, ATTEMPTS NUMBER, FAILURES NUMBER);

CREATE TASK IF NOT EXISTS LS_OPS.ANALYTICS.REFRESH_SYNC_DAILY
  WAREHOUSE = OPS_XS_WH
  SCHEDULE = 'USING CRON 0 * * * * UTC'
  WHEN SYSTEM$STREAM_HAS_DATA('LS_OPS.AUDIT.SYNC_LOGS_STREAM')   -- skip (and don't bill) when nothing new
AS
  MERGE INTO LS_OPS.ANALYTICS.SYNC_DAILY t
  USING (SELECT DATE_TRUNC('day', CREATED_AT)::DATE AS DAY, COUNT(*) AS ATTEMPTS, COUNT_IF(STATUS = 'failed') AS FAILURES
         FROM LS_OPS.AUDIT.SYNC_LOGS_STREAM GROUP BY 1) s
  ON t.DAY = s.DAY
  WHEN MATCHED THEN UPDATE SET t.ATTEMPTS = t.ATTEMPTS + s.ATTEMPTS, t.FAILURES = t.FAILURES + s.FAILURES
  WHEN NOT MATCHED THEN INSERT (DAY, ATTEMPTS, FAILURES) VALUES (s.DAY, s.ATTEMPTS, s.FAILURES);
ALTER TASK LS_OPS.ANALYTICS.REFRESH_SYNC_DAILY RESUME;  -- tasks are created suspended

-- ------------------------------------------------------------------ 5. Pipeline monitoring
-- Failed task runs in the last 24h.
SELECT NAME, STATE, ERROR_CODE, ERROR_MESSAGE, SCHEDULED_TIME, COMPLETED_TIME
FROM TABLE(LS_OPS.INFORMATION_SCHEMA.TASK_HISTORY(SCHEDULED_TIME_RANGE_START => DATEADD('hour', -24, CURRENT_TIMESTAMP())))
WHERE STATE = 'FAILED'
ORDER BY SCHEDULED_TIME DESC;

-- Snowpipe / COPY load errors in the last 24h.
SELECT FILE_NAME, STATUS, ROW_COUNT, ROW_PARSED, FIRST_ERROR_MESSAGE, LAST_LOAD_TIME
FROM TABLE(LS_OPS.INFORMATION_SCHEMA.COPY_HISTORY(
       TABLE_NAME => 'LS_OPS.AUDIT.SYNC_AUDIT_LOGS', START_TIME => DATEADD('hour', -24, CURRENT_TIMESTAMP())))
WHERE STATUS <> 'Loaded';

-- Is the pipe healthy right now? (pendingFileCount, lastIngestedTimestamp, executionState)
SELECT SYSTEM$PIPE_STATUS('LS_OPS.AUDIT.SYNC_LOGS_PIPE');

-- Freshness of every table that feeds Marketing / Finance dashboards.
SELECT TABLE_SCHEMA, TABLE_NAME, ROW_COUNT, LAST_ALTERED,
       DATEDIFF('hour', LAST_ALTERED, CURRENT_TIMESTAMP()) AS HOURS_SINCE_UPDATE
FROM LS_OPS.INFORMATION_SCHEMA.TABLES
WHERE TABLE_TYPE = 'BASE TABLE'
ORDER BY HOURS_SINCE_UPDATE DESC;

-- Credit burn by warehouse, last 7 days (ACCOUNT_USAGE has up to ~3h latency).
SELECT WAREHOUSE_NAME, ROUND(SUM(CREDITS_USED), 2) AS CREDITS_7D
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE START_TIME >= DATEADD('day', -7, CURRENT_TIMESTAMP())
GROUP BY 1
ORDER BY 2 DESC;

-- Guardrail: cap monthly spend on the ops warehouse.
CREATE RESOURCE MONITOR IF NOT EXISTS OPS_MONTHLY_CAP WITH CREDIT_QUOTA = 20
  FREQUENCY = MONTHLY START_TIMESTAMP = IMMEDIATELY
  TRIGGERS ON 80 PERCENT DO NOTIFY ON 100 PERCENT DO SUSPEND;
ALTER WAREHOUSE OPS_XS_WH SET RESOURCE_MONITOR = OPS_MONTHLY_CAP;

-- ------------------------------------------------------------------ 6. Access (RBAC)
CREATE ROLE IF NOT EXISTS ANALYST_RO;
GRANT USAGE ON DATABASE LS_OPS TO ROLE ANALYST_RO;
GRANT USAGE ON ALL SCHEMAS IN DATABASE LS_OPS TO ROLE ANALYST_RO;
GRANT SELECT ON FUTURE TABLES IN SCHEMA LS_OPS.ANALYTICS TO ROLE ANALYST_RO;
GRANT USAGE ON WAREHOUSE OPS_XS_WH TO ROLE ANALYST_RO;
