// Mode: Run Once for Each Item
// A variant with this SKU already exists in Shopify: never create a second product.
// @include lib/sync-helpers.js

// The product data from the earlier "Build Shopify Product" node.
const ctx = $('Build Shopify Product').item.json;
// The existing Shopify variant the lookup found (the first and only result).
const variant = $json.data.productVariants.nodes[0];
// Output one audit log row saying "skipped".
return { json: auditRow({
  // Which n8n run and workflow this was.
  executionId: $execution.id, workflowName: $workflow.name,
  // Data was going from ERPNext to Shopify, as a product.
  source: 'erpnext', target: 'shopify', entityType: 'product',
  // Which SKU, what we tried, and that it was skipped.
  entityId: ctx.sku, sku: ctx.sku, action: 'create_draft_product', status: 'skipped',
  // Explain why, naming the existing Shopify product and its status.
  errorMessage: `SKU already on Shopify (${variant.product.id}, ${variant.product.status})`,
  // Save the existing Shopify product and variant IDs for reference.
  payload: { shopify_product_id: variant.product.id, shopify_variant_id: variant.id },
}) };
