// Mode: Run Once for Each Item
// ERPNext lookup or Sales Order creation failed. The hourly poll retries automatically
// (the order ID makes it idempotent), so only alert on first sighting.
// @include lib/sync-helpers.js

// The cleaned-up order from the earlier "Verify & Normalize Order" node.
const order = $('Verify & Normalize Order').item.json;
// Turn the raw HTTP error into a tidy summary (status code, category, message, retry or not).
const err = summarizeHttpError($json);
// Build one row for the audit log table.
const row = auditRow({
  // Which n8n run and workflow this was.
  executionId: $execution.id, workflowName: $workflow.name,
  // Data was going from Shopify to ERPNext, as a Sales Order.
  source: 'shopify', target: 'erpnext', entityType: 'sales_order',
  // The order ID, its first SKU, what we tried, and that it failed.
  entityId: order.orderGid, sku: order.skus[0], action: 'import_order', status: 'failed',
  httpStatus: err.httpStatus, errorMessage: err.message,
  // Extra details saved as JSON.
  payload: { order_name: order.orderName, source: order.source, category: err.category, retryable: err.retryable },
});
// Slack alert only the first time (webhook). Poll retries stay quiet (null = no message).
const slack = order.source === 'webhook'
  ? `:warning: *Shopify order ${order.orderName} failed to import* (ERP ${err.category}): ${err.message}\n_${err.retryable ? 'Transient: the hourly sync will retry.' : 'Needs a fix in the ERP; the hourly sync retries after that.'}_`
  : null;
// Output the audit row plus the Slack text.
return { json: { ...row, slack_text: slack } };
