// Mode: Run Once for Each Item
// ERPNext call failed (template lookup, create/update, or the variant request).
// @include lib/sync-helpers.js

// The colorway data built earlier by the "Validate & Build ERP Payload" node.
const ctx = $('Validate & Build ERP Payload').item.json;
// Turn the raw HTTP error into a tidy summary (status code, category, message, retry or not).
const err = summarizeHttpError($json);
// Build one row for the audit log table.
const row = auditRow({
  // Which n8n run and workflow this was.
  executionId: $execution.id,
  workflowName: $workflow.name,
  // Data was going from Airtable to ERPNext, as a style template.
  source: 'airtable', target: 'erpnext', entityType: 'item_template',
  // Which record and SKU, what we tried, and that it failed.
  entityId: ctx.recordId, sku: ctx.skuBase, action: 'upsert', status: 'failed',
  httpStatus: err.httpStatus, errorMessage: err.message, approvedAt: ctx.approvedAt,
  // Extra details saved as JSON for troubleshooting.
  payload: { colorway: ctx.colorwayName, category: err.category, retryable: err.retryable, exc_type: err.excType },
});
// The message shown to the user in Airtable: "will retry" for temporary problems, plain error otherwise.
const userMessage = err.retryable
  ? `Temporary ERP problem (${err.category}), will retry automatically on the next sync run: ${err.message}`
  : `ERP ${err.category}: ${err.message}`;
// Output the audit row, plus the Airtable record ID and the update to write back to it.
return { json: { ...row, airtable_record_id: ctx.recordId,
  airtable_patch: syncWriteback({ status: 'failed', errorMessage: userMessage, retryable: err.retryable, nowIso: new Date().toISOString() }) } };
