-- Current sync state per Airtable style: one row per record, latest attempt wins.
with ranked as (
    select
        *,
        row_number() over (partition by entity_id order by created_at desc) as rn,
        count(*)     over (partition by entity_id)                         as attempts,
        min(case when status = 'success' then created_at end) over (partition by entity_id) as first_success_at
    from {{ ref('stg_sync_events') }}
    where entity_type = 'item'
)
select
    entity_id        as airtable_record_id,
    sku,
    status           as latest_status,
    failure_category as latest_failure_category,
    error_message    as latest_error,
    attempts,
    approved_at,
    first_success_at,
    {{ dbt.datediff('approved_at', 'first_success_at', 'minute') }} as minutes_to_erp,
    created_at       as last_attempt_at
from ranked
where rn = 1
