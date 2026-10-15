-- Q2. Error rate by hour of day (UTC), last 30 days.
-- Answers: "Do failures cluster at certain times?" (batch jobs, ERP backups, rate limits at peak).

SELECT EXTRACT(HOUR FROM created_at)::int                                          AS hour_utc,
       COUNT(*)                                                                    AS attempts,
       COUNT(*) FILTER (WHERE status = 'failed')                                   AS failures,
       ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'failed') / COUNT(*), 1)      AS error_rate_pct,
       MODE() WITHIN GROUP (ORDER BY http_status) FILTER (WHERE status = 'failed') AS most_common_failure_http
FROM audit.sync_audit_logs
WHERE created_at >= now() - interval '30 days'
GROUP BY 1
ORDER BY 1;
