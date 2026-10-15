// Mode: Run Once for Each Item
// Input: ERPNext Item list for the order's SKUs. Decides import vs hold.
// @include lib/shopify.js

// The cleaned-up order from the earlier "Verify & Normalize Order" node.
const order = $('Verify & Normalize Order').item.json;
// Compare the order's SKUs with the items the ERP returned. Any problems become "hold reasons".
const holdReasons = matchOrderSkus(order, $json.data || []);
// Send one item on to the next node.
return { json: {
  // Copy every field from the order.
  ...order,
  // true if every SKU is known in the ERP (no hold reasons).
  allKnown: holdReasons.length === 0,
  holdReasons,
  // If there are problems, no Sales Order (null). Otherwise build the ERP Sales Order.
  salesOrder: holdReasons.length ? null : buildSalesOrder(order, {
    // The one customer used for all web orders (default "Shopify Web Orders").
    customer: $env.SHOPIFY_ERP_CUSTOMER || 'Shopify Web Orders',
    // The ERP company and warehouse, from the environment settings.
    company: $env.ERPNEXT_COMPANY,
    warehouse: $env.ERPNEXT_DEFAULT_WAREHOUSE,
  }),
} };
