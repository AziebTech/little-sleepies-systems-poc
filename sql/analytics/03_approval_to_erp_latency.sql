-- Q3. Time from Production approval (Airtable) to SKU live in the ERP.
-- Answers: "How long does Finance wait for a new SKU?" Mean hides outliers, so report p50/p95 too.
-- Uses the FIRST successful sync per record; retries after failures count against latency (they should).

WITH first_success AS (
    SELECT entity_id,
           MIN(approved_at) AS approved_at,
           MIN(created_at)  AS live_at
    FROM audit.sync_audit_logs
    WHERE entity_type = 'item'
      AND status = 'success'
      AND approved_at IS NOT NULL
    GROUP BY entity_id
),
latency AS (
    SELECT entity_id, EXTRACT(EPOCH FROM (live_at - approved_at)) / 60.0 AS minutes
    FROM first_success
    WHERE live_at >= approved_at
)
SELECT COUNT(*)                                                         AS skus,
       ROUND(AVG(minutes)::numeric, 1)                                  AS avg_minutes,
       ROUND((PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY minutes))::numeric, 1) AS p50_minutes,
       ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY minutes))::numeric, 1) AS p95_minutes,
       ROUND(MAX(minutes)::numeric, 1)                                  AS max_minutes,
       COUNT(*) FILTER (WHERE minutes > 60)                             AS over_1h_sla
FROM latency;
