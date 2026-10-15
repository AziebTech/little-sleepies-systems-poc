// Mode: Run Once for Each Item
// HTTP 200 doesn't mean success in GraphQL: inspect `errors` and `userErrors`.
// @include lib/sync-helpers.js
// @include lib/shopify.js

// The product data from the earlier "Build Shopify Product" node.
const ctx = $('Build Shopify Product').item.json;
// Check Shopify's reply for hidden errors. Returns { ok, message, payload }.
const outcome = graphqlOutcome($json, 'productSet');
// The product Shopify created (if any). The "&&" stops it crashing when payload is missing.
const product = outcome.payload && outcome.payload.product;
// Output one audit log row.
return { json: auditRow({
  // Which n8n run and workflow this was.
  executionId: $execution.id, workflowName: $workflow.name,
  // Data went from ERPNext to Shopify, as a product.
  source: 'erpnext', target: 'shopify', entityType: 'product',
  entityId: ctx.sku, sku: ctx.sku, action: 'create_draft_product',
  // "success" or "failed" depending on what Shopify really said.
  status: outcome.ok ? 'success' : 'failed', httpStatus: 200,
  // No message if it worked; otherwise Shopify's reasons.
  errorMessage: outcome.ok ? null : `Shopify rejected productSet: ${outcome.message}`,
  // Save the new Shopify product's ID and status (draft) for reference.
  payload: { shopify_product_id: product && product.id, status: product && product.status },
}) };
