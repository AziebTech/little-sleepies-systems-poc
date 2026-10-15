// Mode: Run Once for Each Item
// Success path: the Shopify order is now a Sales Order in ERPNext.
// @include lib/sync-helpers.js

// The order data from the earlier "Match SKUs & Build Sales Order" node.
const order = $('Match SKUs & Build Sales Order').item.json;
// Output one audit log row saying "success".
return { json: auditRow({
  // Which n8n run and workflow this was.
  executionId: $execution.id, workflowName: $workflow.name,
  // Data went from Shopify to ERPNext, as a Sales Order.
  source: 'shopify', target: 'erpnext', entityType: 'sales_order',
  // The order ID, its first SKU, what we did, and that it worked.
  entityId: order.orderGid, sku: order.skus[0], action: 'import_order', status: 'success', httpStatus: 200,
  // Extra details, including the new Sales Order's name from the ERP's reply.
  payload: { order_name: order.orderName, sales_order: $json.data && $json.data.name, source: order.source,
             skus: order.skus, test: order.test },
}) };
