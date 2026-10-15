-- Q5. SKUs whose LATEST attempt failed (still broken right now), oldest first.
-- This is the support queue: each row is a style Production thinks is approved but Finance can't see.
-- Techniques: ROW_NUMBER() to pick latest event per key (Snowflake: QUALIFY — see sql/snowflake).

WITH ranked AS (
    SELECT l.*,
           ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY created_at DESC) AS rn,
           COUNT(*)     OVER (PARTITION BY entity_id)                         AS attempts
    FROM audit.sync_audit_logs l
    WHERE entity_type = 'item'
)
SELECT entity_id AS airtable_record_id,
       sku,
       attempts,
       http_status,
       error_message,
       created_at                         AS last_attempt_at,
       ROUND(EXTRACT(EPOCH FROM now() - approved_at) / 3600.0, 1) AS hours_since_approval
FROM ranked
WHERE rn = 1
  AND status = 'failed'
ORDER BY approved_at NULLS LAST;
