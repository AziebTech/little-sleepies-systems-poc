-- Q9. Days per stage: how long each hand-off takes, per colorway and on average.
-- PP sample approved → compliance passed → photography delivered → synced to the ERP.
-- "Tightening timelines" starts with knowing which stage eats the calendar.

WITH stages AS (
    SELECT colorway_record_id,
           MAX(colorway_name)                                         AS colorway,
           MAX(launch_date)                                           AS launch_date,
           MAX(completed_on) FILTER (WHERE milestone = 'sample')      AS sample_approved,
           MAX(completed_on) FILTER (WHERE milestone = 'compliance')  AS compliance_passed,
           MAX(completed_on) FILTER (WHERE milestone = 'photo')       AS photo_delivered,
           MAX(completed_on) FILTER (WHERE milestone = 'erp')         AS erp_synced
    FROM analytics.colorway_milestones_current
    GROUP BY colorway_record_id
),
per_colorway AS (
    SELECT colorway, launch_date,
           compliance_passed - sample_approved  AS sample_to_compliance_days,
           photo_delivered - compliance_passed  AS compliance_to_photo_days,
           erp_synced - photo_delivered         AS photo_to_erp_days,
           launch_date - erp_synced             AS erp_buffer_before_launch_days
    FROM stages
)
SELECT * FROM per_colorway
UNION ALL
SELECT 'AVERAGE (completed stages only)', NULL,
       ROUND(AVG(sample_to_compliance_days)), ROUND(AVG(compliance_to_photo_days)),
       ROUND(AVG(photo_to_erp_days)), ROUND(AVG(erp_buffer_before_launch_days))
FROM per_colorway
ORDER BY launch_date NULLS LAST;
