-- Q7. Shopify order exceptions: what's stuck right now and why (latest attempt per order).
-- The "why didn't this order make it into the ERP?" query support teams run first.

WITH latest AS (
    SELECT DISTINCT ON (entity_id)
           entity_id, payload->>'order_name' AS order_no, action, status, http_status, error_message,
           created_at, COUNT(*) OVER (PARTITION BY entity_id) AS attempts
    FROM audit.sync_audit_logs
    WHERE source_system = 'shopify' AND entity_type = 'sales_order'
    ORDER BY entity_id, created_at DESC
)
SELECT order_no,
       CASE
           WHEN action = 'verify_signature'             THEN 'REJECTED (signature)'
           WHEN error_message LIKE 'ON HOLD:%'          THEN 'ON HOLD'
           ELSE 'ERP ERROR'
       END                                               AS exception_type,
       regexp_replace(error_message, '^ON HOLD: ', '')   AS reason,
       attempts,
       created_at                                        AS last_attempt_at
FROM latest
WHERE status = 'failed'
ORDER BY created_at DESC;
