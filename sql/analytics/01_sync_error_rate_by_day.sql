-- Q1. Daily sync volume and error rate, with a 7-day rolling error rate.
-- Answers: "Is the integration getting more or less reliable?"
-- Techniques: FILTER aggregates, NULLIF to avoid divide-by-zero, window frame for rolling metric.

WITH daily AS (
    SELECT date_trunc('day', created_at)::date                       AS day,
           COUNT(*)                                                   AS attempts,
           COUNT(*) FILTER (WHERE status = 'success')                 AS successes,
           COUNT(*) FILTER (WHERE status = 'failed')                  AS failures
    FROM audit.sync_audit_logs
    WHERE created_at >= now() - interval '30 days'
      AND entity_type = 'item'
    GROUP BY 1
)
SELECT day,
       attempts,
       successes,
       failures,
       ROUND(100.0 * failures / NULLIF(attempts, 0), 1)                         AS error_rate_pct,
       ROUND(100.0 * SUM(failures) OVER w / NULLIF(SUM(attempts) OVER w, 0), 1) AS error_rate_7d_pct
FROM daily
WINDOW w AS (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)
ORDER BY day DESC;
