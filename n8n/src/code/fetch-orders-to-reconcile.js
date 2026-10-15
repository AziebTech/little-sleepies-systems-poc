// Mode: Run Once for All Items
// Input: one row per Shopify order from the audit log (latest attempt), or a single empty
// item when there's no history yet ("Always Output Data" on the Postgres node).
// Output: one { polledOrder } item per order that needs (re)processing.
// @include lib/shopify.js

// The store's address from the environment settings (empty if not set).
const domain = $env.SHOPIFY_STORE_DOMAIN || '';
// Add "https://" in front unless it's already there.
const base = domain.startsWith('http') ? domain : `https://${domain}`;
// The full Shopify GraphQL API address, using the configured API version (default 2026-10).
const url = `${base}/admin/api/${$env.SHOPIFY_API_VERSION || '2026-10'}/graphql.json`;
// The access token fetched by the earlier "Get Shopify Token" node.
const token = $('Get Shopify Token').first().json.access_token;

// Helper: send one GraphQL query to Shopify and return the response.
const graphql = (query, variables) => this.helpers.httpRequest({
  // POST to the API address; send and receive JSON.
  method: 'POST', url, json: true, body: { query, variables },
  // Prove who we are with the access token.
  headers: { 'X-Shopify-Access-Token': token },
});

// How far back to look for orders we might have missed.
const LOOKBACK_HOURS = 6; // Shopify stops retrying a webhook after ~4 h
// Read the audit log rows: which orders are already imported, and which need a retry.
const state = classifySyncState($input.all().map((i) => i.json));
// Ask Shopify for the orders that need processing. "await" waits for the answer.
const { orders, stats } = await fetchOrdersToReconcile({
  graphql,
  // The start of the lookback window: now minus 6 hours, as an ISO timestamp.
  sinceIso: new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString(),
  // Orders to skip (already done).
  imported: state.imported,
  // Orders to fetch again by ID (held or failed earlier).
  retryGids: state.retry,
  // Helper that pauses for "ms" milliseconds, used when Shopify asks us to slow down.
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

// Run stats ride along on the first item (visible in the execution log; ignored downstream).
// Output one item per order; only the first item (i === 0) also carries the stats.
return orders.map((o, i) => ({ json: { polledOrder: o, ...(i === 0 ? { pollStats: stats } : {}) } }));
