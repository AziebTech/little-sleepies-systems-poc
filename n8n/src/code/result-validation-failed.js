// Mode: Run Once for Each Item
// Data-quality failure: never reached ERPNext. Fix in Airtable, then set Sync Status = Pending.
// @include lib/sync-helpers.js

// All the validation errors joined into one line, separated by "; ".
const message = $json.errors.join('; ');
// Build one row for the audit log table.
const row = auditRow({
  // Which n8n run and workflow this was.
  executionId: $execution.id,
  workflowName: $workflow.name,
  // Data was going from Airtable to ERPNext, as a style template.
  source: 'airtable', target: 'erpnext', entityType: 'item_template',
  // Which record and SKU, the step that failed (validate), and the errors.
  entityId: $json.recordId, sku: $json.skuBase, action: 'validate', status: 'failed',
  errorMessage: message, approvedAt: $json.approvedAt,
  // Extra details: colorway name and the full list of errors.
  payload: { colorway: $json.colorwayName, errors: $json.errors },
});
// Output the audit row, plus the Airtable record ID and the error to show on that record.
return { json: { ...row, airtable_record_id: $json.recordId,
  airtable_patch: syncWriteback({ status: 'failed', errorMessage: `Validation: ${message}`, nowIso: new Date().toISOString() }) } };
