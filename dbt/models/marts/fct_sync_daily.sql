-- Daily sync KPIs per direction (Airtable→ERP items, ERP→Airtable POs). Feeds a BI dashboard.
select
    created_date,
    source_system,
    target_system,
    entity_type,
    count(*)                                                   as attempts,
    sum(case when status = 'success' then 1 else 0 end)        as successes,
    sum(case when is_failure then 1 else 0 end)                as failures,
    sum(case when failure_category = 'validation' then 1 else 0 end) as validation_failures,
    sum(case when failure_category = 'server' then 1 else 0 end)     as server_failures,
    round(100.0 * sum(case when is_failure then 1 else 0 end) / nullif(count(*), 0), 2) as error_rate_pct
from {{ ref('stg_sync_events') }}
group by 1, 2, 3, 4
