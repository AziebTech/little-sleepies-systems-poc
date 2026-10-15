-- 30 days of synthetic sync history so the analytics queries have something to show
-- before the live flows have run much. Tagged workflow_name = 'demo-seed'.
-- Remove it any time with:  DELETE FROM audit.sync_audit_logs WHERE workflow_name = 'demo-seed';

SELECT setseed(0.42);  -- deterministic demo data

WITH styles AS (
    SELECT g AS n,
           CASE WHEN g % 3 = 0 THEN 'SOLU' ELSE 'LUNA' END AS fabric,
           now() - (random() * interval '30 days') AS approved_at
    FROM generate_series(1, 180) AS g
),
attempts AS (
    -- Each style gets 1–3 attempts; ~12% fail, more often during a simulated ERP outage window.
    SELECT s.n, s.fabric, s.approved_at, a.attempt,
           s.approved_at + (interval '1 minute' * (2 + random() * 40)) * a.attempt AS attempted_at
    FROM styles s
    CROSS JOIN LATERAL generate_series(1, 1 + (s.n % 3)) AS a(attempt)
),
classified AS (
    SELECT *,
           CASE
               WHEN attempted_at BETWEEN now() - interval '9 days' AND now() - interval '8 days 20 hours' THEN 'outage'
               WHEN random() < 0.08 THEN 'validation'
               WHEN random() < 0.04 THEN 'duplicate'
               ELSE 'ok'
           END AS outcome
    FROM attempts
)
INSERT INTO audit.sync_audit_logs
    (execution_id, workflow_name, source_system, target_system, entity_type, entity_id, sku,
     action, status, http_status, error_message, approved_at, payload, created_at)
SELECT
    'seed-' || n || '-' || attempt,
    'demo-seed',
    'airtable', 'erpnext', 'item',
    'recSEED' || lpad(n::text, 5, '0'),
    format('LS-%s-2026-%s', fabric, lpad(n::text, 3, '0')),
    CASE outcome WHEN 'validation' THEN 'validate' WHEN 'ok' THEN CASE WHEN attempt = 1 THEN 'create' ELSE 'update' END ELSE 'upsert' END,
    CASE WHEN outcome = 'ok' THEN 'success' ELSE 'failed' END,
    CASE outcome WHEN 'outage' THEN 502 WHEN 'duplicate' THEN 409 WHEN 'ok' THEN 200 END,
    CASE outcome
        WHEN 'outage' THEN 'HTTP 502 — Bad Gateway (ERPNext backend unavailable)'
        WHEN 'validation' THEN 'Cost Price must be a positive amount (got "")'
        WHEN 'duplicate' THEN 'HTTP 409 — DuplicateEntryError — Item already exists'
    END,
    approved_at,
    jsonb_build_object('seed', true),
    attempted_at
FROM classified
WHERE attempted_at <= now();
