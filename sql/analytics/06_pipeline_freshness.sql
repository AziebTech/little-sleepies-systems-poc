-- Q6. Freshness / SLA check — the same logic LS-03 runs hourly.
-- "Is data flowing?" is a different question from "is it erroring?": a silent pipeline has 0% errors.

SELECT workflow_name,
       MAX(created_at)                                                       AS last_event_at,
       MAX(created_at) FILTER (WHERE status = 'success')                     AS last_success_at,
       ROUND(EXTRACT(EPOCH FROM now() - MAX(created_at) FILTER (WHERE status = 'success')) / 3600.0, 2)
                                                                             AS hours_since_success,
       COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')      AS events_24h,
       CASE
           WHEN MAX(created_at) FILTER (WHERE status = 'success') < now() - interval '24 hours' THEN 'STALE'
           WHEN COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') = 0          THEN 'SILENT'
           ELSE 'OK'
       END                                                                   AS health
FROM audit.sync_audit_logs
GROUP BY workflow_name
ORDER BY health DESC, workflow_name;
