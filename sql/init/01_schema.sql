-- Warehouse schema (Postgres standing in for Snowflake).
-- Runs automatically on first start of the `warehouse` container.
--
-- Layers, mirroring a typical Snowflake setup:
--   audit.*      operational event logs written by n8n / scripts (≈ RAW / landing)
--   analytics.*  views built on top (≈ dbt marts; see dbt/ for the modelled version)

CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS analytics;

-- One row per sync attempt per record. Append-only: never UPDATE, so history is trustworthy.
CREATE TABLE IF NOT EXISTS audit.sync_audit_logs (
    log_id         BIGSERIAL PRIMARY KEY,
    execution_id   TEXT,                       -- n8n execution id → click through to the run
    workflow_name  TEXT,
    source_system  TEXT        NOT NULL,       -- airtable | erpnext
    target_system  TEXT        NOT NULL,
    entity_type    TEXT        NOT NULL,       -- item | purchase_order
    entity_id      TEXT,                       -- Airtable record id or PO name
    sku            TEXT,
    action         TEXT        NOT NULL,       -- create | update | upsert | validate | update_delivery | fetch_po
    status         TEXT        NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
    http_status    INT,
    error_message  TEXT,
    approved_at    TIMESTAMPTZ,                -- when Production approved the style (latency metric)
    payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_sync_logs_created ON audit.sync_audit_logs (created_at);
CREATE INDEX IF NOT EXISTS ix_sync_logs_sku     ON audit.sync_audit_logs (sku, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_sync_logs_status  ON audit.sync_audit_logs (status, created_at);

-- Crashes caught by the LS-00 error workflow.
CREATE TABLE IF NOT EXISTS audit.workflow_errors (
    error_id       BIGSERIAL PRIMARY KEY,
    execution_id   TEXT,
    workflow_id    TEXT,
    workflow_name  TEXT,
    last_node      TEXT,
    error_message  TEXT,
    execution_url  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hourly results of LS-03 (trend of pipeline health over time).
CREATE TABLE IF NOT EXISTS audit.pipeline_health_checks (
    check_id                 BIGSERIAL PRIMARY KEY,
    checked_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    hours_since_last_success NUMERIC(10, 2),
    events_24h               INT,
    failures_24h             INT,
    error_rate_24h           NUMERIC(6, 4),
    status                   TEXT NOT NULL CHECK (status IN ('ok', 'breach')),
    breaches                 JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- Output of python/scripts/reconcile.py --write-warehouse.
CREATE TABLE IF NOT EXISTS audit.reconciliation_findings (
    finding_id         BIGSERIAL PRIMARY KEY,
    run_at             TIMESTAMPTZ NOT NULL,
    kind               TEXT NOT NULL,          -- missing_in_erp | orphan_in_erp | field_mismatch | writeback_missing
    airtable_record_id TEXT,
    sku                TEXT,
    field              TEXT,
    airtable_value     TEXT,
    erp_value          TEXT
);

-- Latest known state per SKU (the "current status" view support teams actually ask for).
CREATE OR REPLACE VIEW analytics.sku_latest_sync AS
SELECT DISTINCT ON (entity_id)
       entity_id AS airtable_record_id, sku, status, action, http_status, error_message, approved_at,
       created_at AS last_attempt_at, workflow_name, execution_id
FROM audit.sync_audit_logs
WHERE entity_type = 'item'
ORDER BY entity_id, created_at DESC;

-- Read-only role for analysts / BI tools (least privilege).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analyst_ro') THEN
        CREATE ROLE analyst_ro NOLOGIN;
    END IF;
END $$;
GRANT USAGE ON SCHEMA audit, analytics TO analyst_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA audit, analytics TO analyst_ro;
