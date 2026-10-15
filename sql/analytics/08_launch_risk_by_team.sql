-- Q8. Launch risk by owning team, right now: which team's milestones are late or due this week,
-- and how late on average. The "where are launches slipping?" view for systems leadership.

SELECT owner_team,
       COUNT(*) FILTER (WHERE status IN ('open_late', 'blocked') AND days_late > 0) AS late,
       COUNT(*) FILTER (WHERE status = 'open_at_risk' OR (status = 'blocked' AND days_late = 0)) AS at_risk,
       COUNT(*) FILTER (WHERE status = 'open_on_track')                          AS on_track,
       COUNT(*) FILTER (WHERE status LIKE 'done%')                               AS done,
       COUNT(*) FILTER (WHERE status = 'done_late')                              AS done_late,
       ROUND(AVG(days_late) FILTER (WHERE status IN ('open_late', 'blocked', 'done_late') AND days_late > 0), 1)
                                                                                 AS avg_days_late,
       STRING_AGG(colorway_name || ' (' || days_late || 'd)', ', ' ORDER BY days_late DESC)
           FILTER (WHERE status IN ('open_late', 'blocked') AND days_late > 0)   AS late_colorways
FROM analytics.colorway_milestones_current
GROUP BY owner_team
ORDER BY late DESC, at_risk DESC;
