// Mode: Run Once for Each Item
// HMAC check failed: either a forged request or a rotated/wrong client secret.
// @include lib/sync-helpers.js

// Build one row for the audit log table.
const row = auditRow({
  // Which n8n run and workflow this was.
  executionId: $execution.id, workflowName: $workflow.name,
  // The request claimed to be a Shopify order for ERPNext.
  source: 'shopify', target: 'erpnext', entityType: 'sales_order',
  // The order ID it claimed, and that the signature check failed (401 = not authorized).
  entityId: $json.orderGid, action: 'verify_signature', status: 'failed', httpStatus: 401,
  errorMessage: 'Invalid or missing X-Shopify-Hmac-Sha256 signature: payload discarded',
  // Extra details saved as JSON, to help work out where the request came from.
  payload: { order_name: $json.orderName, webhook_id: $json.webhookId, shop_domain: $json.shopDomain },
});
// Output the audit row plus a Slack alert explaining the likely cause and fix.
return { json: { ...row, slack_text: `:lock: *Rejected an unsigned/forged Shopify webhook* (claimed order ${$json.orderName || 'n/a'}, shop ${$json.shopDomain || 'n/a'}). If every order is rejected, the app's client secret was probably rotated: update SHOPIFY_CLIENT_SECRET. Runbook §8.` } };
