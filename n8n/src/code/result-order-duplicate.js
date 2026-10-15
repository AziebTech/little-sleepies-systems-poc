// Mode: Run Once for Each Item
// A Sales Order with this Shopify order ID already exists: Shopify retried the webhook,
// or the poll re-saw an imported order. Idempotency working as designed.
// @include lib/sync-helpers.js

// The cleaned-up order from the earlier "Verify & Normalize Order" node.
const order = $('Verify & Normalize Order').item.json;
// Output one audit log row saying "skipped" (not an error: we just didn't import it twice).
return { json: { ...auditRow({
  // Which n8n run and workflow this was.
  executionId: $execution.id, workflowName: $workflow.name,
  // Data was going from Shopify to ERPNext, as a Sales Order.
  source: 'shopify', target: 'erpnext', entityType: 'sales_order',
  // The order ID, its first SKU, what we tried, and the outcome.
  entityId: order.orderGid, sku: order.skus[0], action: 'import_order', status: 'skipped',
  // Name the existing Sales Order ($json.data[0] is the one the ERP lookup found).
  errorMessage: `Already imported as ${($json.data[0] || {}).name}`,
  // Extra details saved as JSON.
  payload: { order_name: order.orderName, source: order.source, webhook_id: order.webhookId },
// Also pass along where the order came from ("webhook" or "poll").
}), source: order.source } };
