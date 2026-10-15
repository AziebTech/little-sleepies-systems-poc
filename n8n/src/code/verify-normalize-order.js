// Mode: Run Once for All Items
// Webhook items: verify the Shopify HMAC over the RAW body (Webhook node "Raw Body" option
// puts it in binary property "data"), then normalize. Poll items ({ polledOrder }) were
// fetched by us with our own token, so they are trusted.
// Requires NODE_FUNCTION_ALLOW_BUILTIN=crypto on the n8n container.
// @include lib/shopify.js

// Node's built-in crypto library, used to check the signature.
const crypto = require('crypto');
// The shared secret Shopify signs webhooks with (from the environment settings).
const secret = $env.SHOPIFY_CLIENT_SECRET;
// Every incoming item.
const items = $input.all();
// The list of items this node will output.
const out = [];

// Go through each item by position (i = 0, 1, 2…).
for (let i = 0; i < items.length; i++) {
  // Pull out the item's normal data (json) and any file data (binary).
  const { json, binary } = items[i];
  // Came from our own poll? It's trusted: clean it up, mark it valid, and move on.
  if (json.polledOrder) {
    out.push({ json: { ...normalizeShopifyOrder(json.polledOrder), source: 'poll', signatureValid: true }, pairedItem: { item: i } });
    // Skip the rest of the loop for this item.
    continue;
  }
  // From here on it's a webhook. Get its HTTP headers (empty if missing).
  const headers = json.headers || {};
  // Read the exact raw bytes Shopify sent (needed for the signature check), or null if none.
  const raw = binary && binary.data ? await this.helpers.getBinaryDataBuffer(i, 'data') : null;
  // Check the signature: true if it really came from Shopify, false if not.
  const signatureValid = verifyShopifyHmac(raw, secret, headers['x-shopify-hmac-sha256'], crypto);
  // Add the cleaned-up order to the output.
  out.push({
    json: {
      // The order in a standard shape (empty object if there's no body).
      ...normalizeShopifyOrder(json.body || {}),
      source: 'webhook',
      signatureValid,
      // Shopify's webhook ID and shop domain from the headers, for troubleshooting.
      webhookId: headers['x-shopify-webhook-id'] || null,
      shopDomain: headers['x-shopify-shop-domain'] || null,
    },
    // Link this output back to the input item it came from.
    pairedItem: { item: i },
  });
}
// Send all the orders on to the next node.
return out;
