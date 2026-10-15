// Mode: Run Once for Each Item
// HTTP-level failure reading the ERP item or calling Shopify.
// @include lib/sync-helpers.js

// The SKU from the webhook that started this run ("ERPNext Item Created" node).
const sku = $('ERPNext Item Created').item.json.body.name;
// Turn the raw HTTP error into a tidy summary (status code, category, message).
const err = summarizeHttpError($json);
// Output one audit log row saying "failed".
return { json: auditRow({
  // Which n8n run and workflow this was.
  executionId: $execution.id, workflowName: $workflow.name,
  // Data was going from ERPNext to Shopify, as a product.
  source: 'erpnext', target: 'shopify', entityType: 'product',
  // Which SKU, what we tried, and that it failed.
  entityId: sku, sku, action: 'create_draft_product', status: 'failed',
  httpStatus: err.httpStatus, errorMessage: err.message, payload: { category: err.category },
}) };
