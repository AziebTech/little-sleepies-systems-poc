// Mode: Run Once for Each Item
// Airtable lookup or update failed for one PO line.
// @include lib/sync-helpers.js

// The PO line from the earlier "Explode PO Lines" node.
const line = $('Explode PO Lines').item.json;
// Turn the raw HTTP error into a tidy summary (status code, category, message).
const err = summarizeHttpError($json);
// Output one audit log row saying "failed".
return { json: auditRow({
  // Which n8n run and workflow this was.
  executionId: $execution.id, workflowName: $workflow.name,
  // Data was going from ERPNext to Airtable, about a Purchase Order.
  source: 'erpnext', target: 'airtable', entityType: 'purchase_order',
  // Which PO and colorway, what we tried, and that it failed.
  entityId: line.po_number, sku: line.item_code, action: 'update_delivery', status: 'failed',
  httpStatus: err.httpStatus, errorMessage: err.message, payload: { category: err.category },
}) };
