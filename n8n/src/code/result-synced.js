// Mode: Run Once for Each Item
// Success path: the style template is created/updated and ERPNext accepted the size-variant
// request. ERPNext creates up to 9 variants inline (returns the count) and queues larger
// size runs to a background worker (returns "queued"); existing sizes are skipped.
// @include lib/sync-helpers.js

// The colorway data built earlier by the "Validate & Build ERP Payload" node.
const ctx = $('Validate & Build ERP Payload').item.json;
// The result of the earlier lookup for an existing ERP template.
const existing = $('Find Existing ERP Template').item.json;
// If the lookup found something, we updated it; otherwise we created it.
const action = (existing.data || []).length ? 'update' : 'create';
// ERPNext's reply to the variant request: a count, or "queued".
const variants = $json.message;

// Build one row for the audit log table.
const row = auditRow({
  // Which n8n run and workflow this was.
  executionId: $execution.id,
  workflowName: $workflow.name,
  // Data went from Airtable to ERPNext, as a style template.
  source: 'airtable', target: 'erpnext', entityType: 'item_template',
  // Which record and SKU, what we did, and that it worked.
  entityId: ctx.recordId, sku: ctx.skuBase, action, status: 'success',
  httpStatus: 200, approvedAt: ctx.approvedAt,
  // Extra details: colorway name, how many sizes, and the variant result.
  payload: { colorway: ctx.colorwayName, sizes: ctx.sizes.length, variants_created: variants },
});
// Output the audit row, plus the Airtable record ID and the "Synced" update to write back to it.
return { json: { ...row, airtable_record_id: ctx.recordId,
  airtable_patch: syncWriteback({ status: 'success', erpItemCode: ctx.skuBase, nowIso: new Date().toISOString() }) } };
