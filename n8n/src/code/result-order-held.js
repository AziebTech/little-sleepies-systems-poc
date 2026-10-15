// Mode: Run Once for Each Item
// Order can't be imported as-is (missing/unknown/disabled SKU, no lines…).
// Alert once (webhook), retry quietly: the hourly reconcile re-fetches held orders by ID
// for up to 7 days, so fixing the SKU in the ERP is enough. No manual replay needed.
// @include lib/sync-helpers.js

// The reasons the order is on hold (empty list if missing).
const reasons = $json.holdReasons || [];
// Build one row for the audit log table.
const row = auditRow({
  // Which n8n run and workflow this was.
  executionId: $execution.id, workflowName: $workflow.name,
  // Data was going from Shopify to ERPNext, as a Sales Order.
  source: 'shopify', target: 'erpnext', entityType: 'sales_order',
  // The order ID, its first SKU, what we tried, and that it failed.
  entityId: $json.orderGid, sku: ($json.skus || [])[0], action: 'import_order', status: 'failed',
  // All the hold reasons in one line, separated by "; ".
  errorMessage: `ON HOLD: ${reasons.join('; ')}`,
  // Extra details saved as JSON.
  payload: { order_name: $json.orderName, source: $json.source, skus: $json.skus, hold_reasons: reasons },
});
// Slack alert only the first time (webhook), listing each reason as a bullet. Poll retries stay quiet.
const slack = $json.source === 'webhook'
  ? `:package: *Shopify order ${$json.orderName} is ON HOLD*: not imported to the ERP.\n• ${reasons.join('\n• ')}\n_Fix the SKU in the ERP; the hourly sync imports it automatically. Runbook §8._`
  : null;
// Output the audit row plus the Slack text.
return { json: { ...row, slack_text: slack } };
