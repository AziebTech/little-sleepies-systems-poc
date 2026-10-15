-- Clean, typed sync events. Excludes seeded demo rows from anything a real dashboard would read
-- unless include_demo_data is set:  dbt build --vars '{include_demo_data: true}'
select
    log_id,
    execution_id,
    workflow_name,
    source_system,
    target_system,
    entity_type,
    entity_id,
    upper(sku)                                   as sku,
    action,
    status,
    status = 'failed'                            as is_failure,
    http_status,
    case
        when http_status in (401, 403)           then 'auth'
        when http_status = 409                   then 'duplicate'
        when http_status = 417 or action = 'validate' and status = 'failed' then 'validation'
        when http_status = 429                   then 'rate_limited'
        when http_status >= 500                  then 'server'
        when status = 'failed'                   then 'other'
    end                                          as failure_category,
    error_message,
    approved_at,
    created_at,
    cast(created_at as date)                     as created_date
from {{ source('audit', 'sync_audit_logs') }}
{% if not var('include_demo_data', false) %}
where workflow_name is distinct from 'demo-seed'
{% endif %}
