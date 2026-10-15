// Mode: Run Once for Each Item
// PO line for an item that has no Airtable style (e.g. created directly in the ERP).
// @include lib/sync-helpers.js

// The PO line from the earlier "Explode PO Lines" node.
const line = $('Explode PO Lines').item.json;
// Output one audit log row saying "skipped" (nothing in Airtable to update).
return { json: auditRow({
  // Which n8n run and workflow this was.
  executionId: $execution.id, workflowName: $workflow.name,
  // Data was going from ERPNext to Airtable, about a Purchase Order.
  source: 'erpnext', target: 'airtable', entityType: 'purchase_order',
  // Which PO and colorway, what we tried, and that it was skipped.
  entityId: line.po_number, sku: line.item_code, action: 'update_delivery', status: 'skipped',
  // Explain why, so someone can fix it.
  errorMessage: `No Airtable style with ERP Item Code ${line.item_code}`,
}) };
