-- Singular test: a successful item sync must always record the SKU it created/updated.
-- Returns offending rows; dbt fails the test if any come back.
select log_id, entity_id, status, sku
from {{ ref('stg_sync_events') }}
where entity_type = 'item'
  and status = 'success'
  and (sku is null or sku = '')
