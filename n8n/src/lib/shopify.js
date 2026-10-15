// ---- lib/shopify.js -----------------------------------------------------
// Shopify ↔ ERPNext helpers shared by the LS-04 / LS-05 Code nodes. Pure functions;
// the caller passes in `crypto` so this file runs in n8n and in unit tests alike.

// Shopify signs each webhook: base64(HMAC-SHA256(raw body, app client secret)) in the
// X-Shopify-Hmac-Sha256 header. Must be computed over the RAW bytes, never re-serialized JSON.
function verifyShopifyHmac(rawBody, secret, headerValue, cryptoLib) {
  // Missing the body, the secret or the signature? Can't be valid.
  if (!rawBody || !secret || !headerValue) return false;
  // Work out what the signature SHOULD be, using our copy of the secret.
  const expected = cryptoLib.createHmac('sha256', secret).update(rawBody).digest('base64');
  // Valid only if it matches the signature Shopify sent.
  return constantTimeEqual(expected, String(headerValue).trim());
}

// Compare without short-circuiting, so response timing doesn't leak how much matched.
function constantTimeEqual(a, b) {
  // Different lengths can never match.
  if (a.length !== b.length) return false;
  // Stays 0 only if every character matches.
  let diff = 0;
  // Compare every character (XOR is 0 when two characters are equal); never stop early.
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  // Equal if no differences were found.
  return diff === 0;
}

// Accepts BOTH shapes: the REST-style webhook payload (orders/create) and a GraphQL
// `orders` node from the safety-net poll. Uses the string GID, never the numeric `id`:
// Shopify IDs exceed Number.MAX_SAFE_INTEGER and get silently rounded by JSON.parse.
function normalizeShopifyOrder(o) {
  // Only the GraphQL shape has "lineItems", so that tells us which shape we have.
  const isGraphql = Boolean(o && o.lineItems);
  // The order lines, from whichever field this shape uses.
  const rawLines = isGraphql ? (o.lineItems.nodes || []) : (o.line_items || []);
  // Build one standard order shape, picking each value from the right field.
  const order = {
    orderGid: (isGraphql ? o.id : o.admin_graphql_api_id) || null,
    orderName: o.name || null,
    createdAt: (isGraphql ? o.createdAt : o.created_at) || null,
    currency: (isGraphql ? o.currencyCode : o.currency) || null,
    // true for Shopify test orders.
    test: Boolean(o.test),
    // Each line in a standard shape too.
    lines: rawLines.map((l) => ({
      // SKU with spaces trimmed off.
      sku: (l.sku || '').trim(),
      // Quantity as a number (0 if missing).
      qty: Number(l.quantity) || 0,
      // Unit price as a number; GraphQL keeps it deeper inside the line.
      price: Number(isGraphql ? l.originalUnitPriceSet && l.originalUnitPriceSet.shopMoney.amount : l.price),
      // A readable name for error messages.
      title: l.title || l.name || '',
    })),
  };

  // Reasons this order can't be imported (empty = fine).
  const holdReasons = [];
  // No order ID: we couldn't tell it apart from other orders.
  if (!order.orderGid) holdReasons.push('Order has no admin_graphql_api_id');
  // Nothing to import.
  if (!order.lines.length) holdReasons.push('Order has no line items');
  // Check each line.
  order.lines.forEach((l) => {
    // Every line needs a SKU to match it to an ERP item.
    if (!l.sku) holdReasons.push(`Line "${l.title}" has no SKU (gift card, custom item or a variant missing its SKU in Shopify)`);
    // Quantity must be more than zero.
    if (l.qty <= 0) holdReasons.push(`Line "${l.title}" has quantity ${l.qty}`);
    // Price must be a real number, 0 or more (this also catches "not a number").
    if (!(l.price >= 0)) holdReasons.push(`Line "${l.title}" has an unreadable price`);
  });
  // Return the order, plus its unique SKUs, whether it's valid, and any hold reasons.
  return { ...order, skus: [...new Set(order.lines.map((l) => l.sku).filter(Boolean))], valid: holdReasons.length === 0, holdReasons };
}

// Compare order SKUs with the ERP's Item list → reasons to hold the order (empty = OK).
function matchOrderSkus(order, erpItems) {
  // Lookup table: item code → ERP item.
  const byCode = new Map((erpItems || []).map((i) => [i.name, i]));
  // Problems found.
  const reasons = [];
  // Check each SKU on the order.
  for (const sku of order.skus) {
    // Find it in the ERP.
    const item = byCode.get(sku);
    // Not in the ERP at all.
    if (!item) reasons.push(`Unknown SKU ${sku}: no ERP item with this code`);
    // In the ERP but switched off.
    else if (Number(item.disabled)) reasons.push(`SKU ${sku} is disabled in the ERP`);
    // Templates (S-0108-0901) are style-level records; only size variants can be sold.
    else if (Number(item.has_variants)) reasons.push(`SKU ${sku} is a style template, not a size: the Shopify variant is missing its size code`);
  }
  return reasons;
}

// Add a number of days to a date like "2026-10-12" and return the new date in the same format.
function addDays(isoDate, days) {
  // Make a date at midnight UTC (so time zones can't shift the day).
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  // Move it forward by "days".
  d.setUTCDate(d.getUTCDate() + days);
  // Back to "YYYY-MM-DD".
  return d.toISOString().slice(0, 10);
}

// ERPNext Sales Order payload. One "channel customer" for all web orders: the common
// connector pattern when the ERP doesn't need individual consumers (and avoids PII).
function buildSalesOrder(order, { customer, company, warehouse, leadDays = 5 }) {
  // The order date (or today if missing), as "YYYY-MM-DD".
  const orderDate = (order.createdAt || new Date().toISOString()).slice(0, 10);
  // Expected delivery: order date plus 5 days by default.
  const deliveryDate = addDays(orderDate, leadDays);
  return {
    doctype: 'Sales Order',
    customer,
    // Only include company and warehouse if they were given.
    ...(company ? { company } : {}),
    ...(warehouse ? { set_warehouse: warehouse } : {}),
    transaction_date: orderDate,
    delivery_date: deliveryDate,
    // The Shopify order number (e.g. #1001) as the customer PO number.
    po_no: order.orderName,
    // Our custom fields that link this Sales Order back to the Shopify order.
    custom_shopify_order_id: order.orderGid,
    custom_shopify_order_name: order.orderName,
    // One Sales Order line per order line.
    items: order.lines.map((l) => ({
      item_code: l.sku,
      qty: l.qty,
      // Price rounded to 2 decimals (cents).
      rate: Math.round(l.price * 100) / 100,
      delivery_date: deliveryDate,
      ...(warehouse ? { warehouse } : {}),
    })),
    // Created as a draft, then submitted by a second call: in ERPNext v16 inserting with
    // docstatus=1 in one request skips the status update (doc stays 'Draft' while submitted).
  };
}

// GraphQL reports most failures with HTTP 200: check top-level `errors` (auth, throttling,
// bad query) AND the mutation's `userErrors` (validation). Missing either is a silent failure.
function graphqlOutcome(resp, mutationKey) {
  // Every problem found.
  const errors = [];
  // Top-level errors, e.g. "THROTTLED: too many requests".
  for (const e of (resp && resp.errors) || []) {
    errors.push(`${(e.extensions && e.extensions.code) || 'GRAPHQL'}: ${e.message}`);
  }
  // The part of the reply for our mutation (e.g. resp.data.productSet), or null.
  const payload = mutationKey && resp && resp.data ? resp.data[mutationKey] : null;
  // Validation errors on specific fields, e.g. "title: can't be blank".
  for (const u of (payload && payload.userErrors) || []) {
    errors.push(`${(u.field || []).join('.') || 'input'}: ${u.message}`);
  }
  // No errors but also no result? That's still a failure.
  if (mutationKey && !payload && !errors.length) errors.push(`No ${mutationKey} payload in response`);
  // ok = no errors. message = all errors in one line.
  return { ok: errors.length === 0, message: errors.join('; '), payload };
}

// ---- Safety-net poll (LS-05) ---------------------------------------------
// Two jobs, kept separate so neither depends on order volume:
//  1. Missed webhooks: page through ALL orders created in the last few hours, skipping
//     those the audit log already shows as imported.
//  2. Held / failed orders: fetch them BY ID from the audit log's list, so retries don't
//     depend on how many orders arrived since.
// Page sizes keep each query under Shopify's 1,000-point single-query cost limit
// (25 orders × 30 lines ≈ 775 requested points).
// The order fields we ask Shopify for (same list in both queries below).
const ORDER_FIELDS = 'id name createdAt currencyCode test lineItems(first: 30) { nodes { sku quantity title originalUnitPriceSet { shopMoney { amount } } } }';
// Query 1: recent orders, 25 per page. "$after" says which page to fetch next.
const RECENT_ORDERS_QUERY = `query recentOrders($q: String!, $after: String) { orders(first: 25, after: $after, query: $q, sortKey: CREATED_AT) { pageInfo { hasNextPage endCursor } nodes { ${ORDER_FIELDS} } } }`;
// Query 2: specific orders by their IDs.
const ORDERS_BY_ID_QUERY = `query ordersById($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { ${ORDER_FIELDS} } } }`;

// Audit rows (latest attempt per Shopify order) → what the poll should skip and retry.
function classifySyncState(rows) {
  // Orders already done (no need to fetch again).
  const imported = new Set();
  // Orders that failed and should be tried again.
  const retry = [];
  // Look at each audit row.
  for (const r of rows || []) {
    // Skip empty rows (e.g. the placeholder row when there's no history yet).
    if (!r || !r.order_gid) continue;
    // Imported, or skipped as a duplicate: done.
    if (r.status === 'success' || r.status === 'skipped') imported.add(r.order_gid);
    // Failed to import: retry it.
    else if (r.status === 'failed' && r.action === 'import_order') retry.push(r.order_gid);
    // verify_signature failures are NOT retried by ID (the GID may be forged); if it was a
    // real order rejected after a secret rotation, the recent-orders pass picks it up.
  }
  return { imported, retry };
}

// graphql(query, variables) → response body; sleep(ms) → Promise. Both injected so this runs
// in an n8n Code node (this.helpers.httpRequest) and in unit tests (mocks).
async function fetchOrdersToReconcile({ graphql, sinceIso, imported, retryGids, maxPages = 200, sleep = async () => {} }) {
  // Counters for the execution log.
  const stats = { pages: 0, scanned: 0, skippedImported: 0, retriedById: 0, truncated: false, throttleWaits: 0 };
  // Orders to process, keyed by ID so none appears twice.
  const byId = new Map();

  // Helper: run a query; if Shopify says "slow down" (THROTTLED), wait and try again.
  const call = async (query, variables) => {
    // Up to 6 tries.
    for (let attempt = 0; attempt < 6; attempt++) {
      // Send the query and wait for the reply.
      const resp = await graphql(query, variables);
      // Did Shopify say we're going too fast?
      const throttled = (resp.errors || []).some((e) => e.extensions && e.extensions.code === 'THROTTLED');
      // Not throttled:
      if (!throttled) {
        // Any other error is a real failure: stop with an error.
        if (resp.errors && resp.errors.length) throw new Error(`Shopify GraphQL: ${resp.errors.map((e) => e.message).join('; ')}`);
        // Success: return the data.
        return resp.data;
      }
      // Throttled: count it...
      stats.throttleWaits++;
      // ...and wait a bit longer each time (2s, 4s, 6s…) before trying again.
      await sleep(2000 * (attempt + 1)); // cost bucket refills each second; back off and retry
    }
    // Still throttled after 6 tries: give up with an error.
    throw new Error('Shopify GraphQL: still THROTTLED after 6 attempts');
  };

  // Job 1: page through recent orders. "after" marks where the next page starts (null = first page).
  let after = null;
  do {
    // Safety limit: stop after too many pages and note that the list was cut short.
    if (stats.pages >= maxPages) { stats.truncated = true; break; }
    // Fetch one page of orders created since "sinceIso".
    const data = await call(RECENT_ORDERS_QUERY, { q: `created_at:>='${sinceIso}'`, after });
    stats.pages++;
    // Check each order on the page.
    for (const o of data.orders.nodes) {
      stats.scanned++;
      // Already imported? Skip it. Otherwise add it to the list to process.
      if (imported.has(o.id)) stats.skippedImported++;
      else byId.set(o.id, o);
    }
    // More pages? Remember where the next one starts. Otherwise null, which ends the loop.
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (after);

  // Job 2: orders to retry that weren't already picked up in Job 1 (duplicates removed).
  const pending = [...new Set(retryGids)].filter((id) => !byId.has(id));
  // Fetch them 25 at a time.
  for (let i = 0; i < pending.length; i += 25) {
    const data = await call(ORDERS_BY_ID_QUERY, { ids: pending.slice(i, i + 25) });
    // Add each order Shopify returned.
    for (const o of data.nodes || []) {
      if (o && o.id) { byId.set(o.id, o); stats.retriedById++; } // null = order deleted in Shopify
    }
  }
  // Return the orders as a list, plus the counters.
  return { orders: [...byId.values()], stats };
}

// The Shopify request that creates (or updates) a product with all its variants in one go.
const PRODUCT_SET_MUTATION =`mutation productSet($input: ProductSetInput!) {
  productSet(synchronous: true, input: $input) {
    product { id status variants(first: 1) { nodes { id sku } } }
    userErrors { field message }
  }
}`;

// Tag taxonomy modelled on the live storefront (division:, print_family:, launchMMDDYY…).
// Make text tag-safe: lowercase, non-letters/digits become "-", no "-" at either end.
const tagSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Turn "2026-10-12" into "101226" (month, day, 2-digit year). null if no date.
const mmddyy = (iso) => (iso ? `${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(2, 4)}` : null);

// Build the list of Shopify tags for a product.
function shopifyTags(item, price) {
  // Each line is a tag, or false/null when the data for it is missing ("a && b" gives b only if a is set).
  const tags = [
    `division:${tagSlug(item.item_group)}`,
    item.custom_print_family && `print_family:${item.custom_print_family}`,
    item.custom_print_category && `print_category:${tagSlug(item.custom_print_category)}`,
    item.custom_launch_date && `launch${mmddyy(item.custom_launch_date)}`,
    item.custom_merch_date && `merch${mmddyy(item.custom_merch_date)}`,
    item.custom_inventory_tier && `inventory_tier:${item.custom_inventory_tier}`,
    Number(item.custom_limited_edition) && 'tag_Limited Edition',
    // Always added, so we can find products this sync created.
    'erp-sync',
    // Flag products with no price yet.
    price === '0.00' && 'needs-pricing',
  ];
  // Drop the false/null entries.
  return tags.filter(Boolean);
}

// ERPNext style TEMPLATE → Shopify productSet: one DRAFT product per colorway with a Size
// option and one variant per size (SKU = template code + size code, same rule ERPNext uses
// for its variants). Built from the template's size run, so it doesn't race the ERP's
// variant creation. Draft, because merchandising owns imagery and publishing.
// Needs lib/product-model.js (sizeRunSkus).
function buildProductSetRequest(item) {
  // Retail price as text with 2 decimals, or "0.00" if there isn't a positive price.
  const price = Number(item.custom_retail_price) > 0 ? Number(item.custom_retail_price).toFixed(2) : '0.00';
  // Turn the stored size run ("Preemie|Newborn|…") into one SKU per size. "unknown" = sizes with no code.
  const { variants, unknown } = sizeRunSkus(item.name, String(item.custom_size_run || '').split('|').filter(Boolean));
  // No usable sizes? Stop with a clear error.
  if (!variants.length) throw new Error(`Template ${item.name} has no size run with known size codes (${unknown.join(', ') || 'empty'})`);
  return {
    query: PRODUCT_SET_MUTATION,
    variables: {
      input: {
        title: item.item_name,
        // Always a draft: a person publishes it later.
        status: 'DRAFT',
        vendor: 'LSS Demo', // not the real brand: this is an unaffiliated demo store
        productType: item.custom_product_type || item.item_group,
        // The description in a paragraph, with "<" and ">" removed so it can't inject HTML.
        descriptionHtml: `<p>${String(item.description || '').replace(/[<>]/g, '')}</p>`,
        tags: shopifyTags(item, price),
        // One "Size" option listing every size.
        productOptions: [{ name: 'Size', position: 1, values: variants.map((v) => ({ name: v.size })) }],
        // One variant per size, each with its own SKU and the same price.
        variants: variants.map((v) => ({ optionValues: [{ optionName: 'Size', name: v.size }], price, sku: v.sku })),
      },
    },
    // The first size's SKU, used to check if the product already exists in Shopify.
    firstSku: variants[0].sku,
  };
}
