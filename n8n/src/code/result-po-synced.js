// Mode: Run Once for Each Item
// Success path: the PO's quantity and delivery date were written to Airtable.
// @include lib/sync-helpers.js

// The PO line from the earlier "Explode PO Lines" node.
const line = $('Explode PO Lines').item.json;
// Output one audit log row saying "success".
return { json: auditRow({
  // Which n8n run and workflow this was.
  executionId: $execution.id, workflowName: $workflow.name,
  // Data went from ERPNext to Airtable, about a Purchase Order.
  source: 'erpnext', target: 'airtable', entityType: 'purchase_order',
  // Which PO and colorway, what we did, and that it worked.
  entityId: line.po_number, sku: line.item_code, action: 'update_delivery', status: 'success',
  // Extra details: the Airtable record we updated ($json.id), the quantity and delivery date.
  httpStatus: 200, payload: { airtable_record_id: $json.id, qty: line.qty, expected_delivery: line.expected_delivery },
}) };
