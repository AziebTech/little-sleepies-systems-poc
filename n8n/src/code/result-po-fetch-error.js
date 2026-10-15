// Mode: Run Once for Each Item
// Could not read the Purchase Order from ERPNext.
// @include lib/sync-helpers.js

// The PO name from the earlier "Collect PO Names" node.
const poName = $('Collect PO Names').item.json.po_name;
// Turn the raw HTTP error into a tidy summary (status code, category, message).
const err = summarizeHttpError($json);
// Output one audit log row saying "failed".
return { json: auditRow({
  // Which n8n run and workflow this was.
  executionId: $execution.id, workflowName: $workflow.name,
  // Data was going from ERPNext to Airtable, about a Purchase Order.
  source: 'erpnext', target: 'airtable', entityType: 'purchase_order',
  // Which PO, what we tried, and that it failed.
  entityId: poName, action: 'fetch_po', status: 'failed',
  httpStatus: err.httpStatus, errorMessage: err.message, payload: { category: err.category },
}) };
