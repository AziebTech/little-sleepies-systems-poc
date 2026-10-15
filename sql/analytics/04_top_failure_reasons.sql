-- Q4. Top failure reasons, last 7 days — the "what should I fix first?" query.
-- Normalizes messages so "Item LS-LUNA-2026-001 already exists" and "...-002..." group together.

SELECT http_status,
       regexp_replace(error_message, 'LS-[A-Z]{4}-\d{4}-\d{3,4}', '<SKU>', 'g') AS failure_reason,
       COUNT(*)                                                            AS occurrences,
       COUNT(DISTINCT entity_id)                                           AS records_affected,
       MAX(created_at)                                                     AS last_seen
FROM audit.sync_audit_logs
WHERE status = 'failed'
  AND created_at >= now() - interval '7 days'
GROUP BY 1, 2
ORDER BY occurrences DESC
LIMIT 10;
