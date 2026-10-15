-- Product model v2: launch critical-path snapshots written by n8n LS-06.
-- Idempotent, so it doubles as the migration for an existing warehouse:
--   docker compose exec -T warehouse psql -U ls_admin -d ls_warehouse < sql/init/03_product_model.sql

CREATE TABLE IF NOT EXISTS audit.colorway_milestones (
    snapshot_id         BIGSERIAL PRIMARY KEY,
    run_id              TEXT        NOT NULL,      -- n8n execution id: one run = one snapshot
    captured_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    colorway_record_id  TEXT        NOT NULL,      -- Airtable record id
    colorway_name       TEXT,
    sku_base            TEXT,                      -- DIVISION-STYLE-COLORWAY, e.g. S-0108-0665
    launch_date         DATE,
    milestone           TEXT        NOT NULL,      -- sample | license | compliance | photo | erp
    owner_team          TEXT        NOT NULL,
    due_date            DATE,
    completed_on        DATE,
    status              TEXT        NOT NULL CHECK (status IN
                        ('done_on_time', 'done_late', 'open_on_track', 'open_at_risk', 'open_late', 'blocked', 'open_no_date')),
    days_late           INT         NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_colorway_milestones_latest
    ON audit.colorway_milestones (colorway_record_id, milestone, captured_at DESC);

-- The "current board": rows from the most recent LS-06 run only. Each run is one INSERT, so
-- all its rows share captured_at (transaction time). Using the latest run, not the latest row
-- per record, means colorways deleted or cancelled since then drop off the board.
CREATE OR REPLACE VIEW analytics.colorway_milestones_current AS
SELECT *
FROM audit.colorway_milestones
WHERE captured_at = (SELECT MAX(captured_at) FROM audit.colorway_milestones);

GRANT SELECT ON audit.colorway_milestones, analytics.colorway_milestones_current TO analyst_ro;
