import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { loadLib, plain, runCodeNode, runCodeNodeAsync, shopifyWebhookCase as hook } from './helpers.mjs';

const lib = loadLib('product-model.js', 'shopify.js');

const restOrder = (overrides = {}) => ({
  admin_graphql_api_id: 'gid://shopify/Order/820982911946154500',
  id: 820982911946154500,
  name: '#1001',
  created_at: '2026-10-08T10:00:00-05:00',
  currency: 'USD',
  test: true,
  line_items: [
    { sku: 'S-0108-0901-10', quantity: 2, price: '34.00', title: 'Midnight Moons' },
    { sku: 'S-0110-0902-12', quantity: 1, price: '28.50', title: 'Ocean Waves' },
  ],
  ...overrides,
});

describe('verifyShopifyHmac', () => {
  it('accepts the shared fixture signed with the app secret', () => {
    assert.equal(lib.verifyShopifyHmac(hook.body, hook.secret, hook.signature, crypto), true);
  });
  it('rejects a tampered body, wrong secret, or missing header', () => {
    assert.ok(hook.body.includes('"quantity":2'));
    assert.equal(lib.verifyShopifyHmac(hook.body.replace('"quantity":2', '"quantity":20'), hook.secret, hook.signature, crypto), false);
    assert.equal(lib.verifyShopifyHmac(hook.body, 'wrong-secret', hook.signature, crypto), false);
    assert.equal(lib.verifyShopifyHmac(hook.body, hook.secret, undefined, crypto), false);
    assert.equal(lib.verifyShopifyHmac(hook.body, '', hook.signature, crypto), false);
  });
  it('fails if the body is re-serialized instead of using raw bytes', () => {
    // JSON.stringify(JSON.parse(raw)) changes the bytes (unicode, the huge id), so the HMAC no longer matches.
    const reserialized = JSON.stringify(JSON.parse(hook.body));
    assert.notEqual(reserialized, hook.body);
    assert.equal(lib.verifyShopifyHmac(reserialized, hook.secret, hook.signature, crypto), false);
  });
});

describe('normalizeShopifyOrder', () => {
  it('uses the string GID, never the unsafe numeric id', () => {
    const o = plain(lib.normalizeShopifyOrder(restOrder()));
    assert.equal(o.orderGid, 'gid://shopify/Order/820982911946154500');
    // The reason why: the numeric id can't survive JSON.parse intact.
    assert.notEqual(String(JSON.parse('{"id":820982911946154511}').id), '820982911946154511');
    assert.deepEqual(o.skus, ['S-0108-0901-10', 'S-0110-0902-12']);
    assert.equal(o.lines[0].price, 34);
    assert.equal(o.valid, true);
  });

  it('reads the GraphQL shape from the safety-net poll identically', () => {
    const gql = {
      id: 'gid://shopify/Order/1', name: '#1002', createdAt: '2026-10-08T15:00:00Z', currencyCode: 'USD', test: false,
      lineItems: { nodes: [{ sku: 'S-0108-0901-10', quantity: 3, title: 'Midnight Moons', originalUnitPriceSet: { shopMoney: { amount: '34.0' } } }] },
    };
    const o = plain(lib.normalizeShopifyOrder(gql));
    assert.equal(o.orderGid, 'gid://shopify/Order/1');
    assert.deepEqual(o.lines, [{ sku: 'S-0108-0901-10', qty: 3, price: 34, title: 'Midnight Moons' }]);
  });

  it('holds orders with SKU-less lines (gift cards, custom items)', () => {
    const o = plain(lib.normalizeShopifyOrder(restOrder({ line_items: [{ sku: '', quantity: 1, price: '25.00', title: 'Gift Card' }] })));
    assert.equal(o.valid, false);
    assert.match(o.holdReasons[0], /Gift Card.*no SKU/);
  });
});

describe('matchOrderSkus + buildSalesOrder', () => {
  const order = lib.normalizeShopifyOrder(restOrder());
  it('flags unknown and disabled SKUs', () => {
    const reasons = plain(lib.matchOrderSkus(order, [{ name: 'S-0108-0901-10', disabled: 1 }]));
    const template = plain(lib.matchOrderSkus({ skus: ['S-0108-0901'] }, [{ name: 'S-0108-0901', disabled: 0, has_variants: 1 }]));
    assert.match(template[0], /is a style template, not a size/);
    assert.deepEqual(reasons, [
      'SKU S-0108-0901-10 is disabled in the ERP',
      'Unknown SKU S-0110-0902-12: no ERP item with this code',
    ]);
  });
  it('builds a submitted Sales Order keyed by the Shopify GID', () => {
    const so = plain(lib.buildSalesOrder(order, { customer: 'Shopify Web Orders', company: 'LSS', warehouse: 'Stores - LSS' }));
    assert.equal(so.custom_shopify_order_id, 'gid://shopify/Order/820982911946154500');
    assert.equal(so.transaction_date, '2026-10-08');
    assert.equal(so.delivery_date, '2026-10-13');
    assert.equal(so.docstatus, undefined); // submitted by a separate call
    assert.deepEqual(so.items[1], { item_code: 'S-0110-0902-12', qty: 1, rate: 28.5, delivery_date: '2026-10-13', warehouse: 'Stores - LSS' });
  });
});

describe('graphqlOutcome', () => {
  it('treats HTTP-200 userErrors as failure', () => {
    const r = lib.graphqlOutcome({ data: { productSet: { product: null, userErrors: [{ field: ['input', 'variants', '0', 'sku'], message: 'SKU is too long' }] } } }, 'productSet');
    assert.equal(r.ok, false);
    assert.equal(r.message, 'input.variants.0.sku: SKU is too long');
  });
  it('treats top-level errors (auth, throttling) as failure', () => {
    const r = lib.graphqlOutcome({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }, 'productSet');
    assert.equal(r.message, 'THROTTLED: Throttled');
  });
  it('passes a clean response', () => {
    assert.equal(lib.graphqlOutcome({ data: { productSet: { product: { id: 'gid://shopify/Product/1' }, userErrors: [] } } }, 'productSet').ok, true);
  });
});

describe('buildProductSetRequest', () => {
  const template = {
    name: 'S-0108-0901', item_name: 'Midnight Moons Zippy', item_group: 'Sleep', custom_product_type: 'Zippy',
    custom_size_run: 'Preemie|Newborn|3T', custom_retail_price: 36, custom_print_family: 'midnight-moons',
    custom_print_category: 'Stripes & Solids', custom_launch_date: '2026-10-08', custom_merch_date: '2026-10-08',
    custom_inventory_tier: 1, custom_limited_edition: 1,
  };

  it('creates one DRAFT product per colorway with a variant per size', () => {
    const req = plain(lib.buildProductSetRequest(template));
    const input = req.variables.input;
    assert.equal(input.status, 'DRAFT');
    assert.equal(input.vendor, 'LSS Demo');
    assert.equal(input.productType, 'Zippy');
    assert.deepEqual(input.productOptions, [{ name: 'Size', position: 1, values: [{ name: 'Preemie' }, { name: 'Newborn' }, { name: '3T' }] }]);
    assert.deepEqual(input.variants.map((v) => [v.sku, v.price]), [['S-0108-0901-10', '36.00'], ['S-0108-0901-11', '36.00'], ['S-0108-0901-08', '36.00']]);
    assert.equal(req.firstSku, 'S-0108-0901-10');
    assert.match(req.query, /productSet\(synchronous: true/);
  });

  it('tags products the way the live storefront does', () => {
    const tags = plain(lib.buildProductSetRequest(template)).variables.input.tags;
    assert.deepEqual(tags, ['division:sleep', 'print_family:midnight-moons', 'print_category:stripes-solids',
      'launch100826', 'merch100826', 'inventory_tier:1', 'tag_Limited Edition', 'erp-sync']);
  });

  it('flags unpriced products and refuses templates without a size run', () => {
    const unpriced = plain(lib.buildProductSetRequest({ ...template, custom_retail_price: null }));
    assert.ok(unpriced.variables.input.tags.includes('needs-pricing'));
    assert.throws(() => lib.buildProductSetRequest({ ...template, custom_size_run: '' }), /no size run/);
  });
});

describe('LS-05 code nodes', () => {
  const env = { SHOPIFY_CLIENT_SECRET: hook.secret, ERPNEXT_COMPANY: 'LSS', ERPNEXT_DEFAULT_WAREHOUSE: 'Stores - LSS' };

  it('Verify & Normalize accepts a correctly signed webhook and rejects a forged one', async () => {
    const headers = (sig) => ({ 'x-shopify-hmac-sha256': sig, 'x-shopify-webhook-id': 'wh-1', 'x-shopify-shop-domain': 'ls-poc.myshopify.com' });
    const out = await runCodeNodeAsync('verify-normalize-order.js', {
      env,
      items: [
        { json: { headers: headers(hook.signature), body: JSON.parse(hook.body) }, binary: { data: {} } },
        { json: { headers: headers('forged'), body: JSON.parse(hook.body) }, binary: { data: {} } },
        { json: { polledOrder: { id: 'gid://shopify/Order/9', name: '#9', lineItems: { nodes: [] } } } },
      ],
      binaries: [hook.body, hook.body],
    });
    assert.deepEqual(out.map((o) => [o.json.source, o.json.signatureValid]), [['webhook', true], ['webhook', false], ['poll', true]]);
    assert.equal(out[0].json.orderGid, 'gid://shopify/Order/820982911946154511');
    assert.equal(out[2].json.valid, false); // polled order with no lines → held
  });

  it('Match SKUs builds the Sales Order only when every SKU is known', () => {
    const order = plain(lib.normalizeShopifyOrder(restOrder()));
    const ok = runCodeNode('match-order-skus.js', {
      env, json: { data: [{ name: 'S-0108-0901-10', disabled: 0 }, { name: 'S-0110-0902-12', disabled: 0 }] },
      refs: { 'Verify & Normalize Order': { ...order, source: 'webhook' } },
    }).json;
    assert.equal(ok.allKnown, true);
    assert.equal(ok.salesOrder.customer, 'Shopify Web Orders');
    assert.equal(ok.salesOrder.set_warehouse, 'Stores - LSS');

    const held = runCodeNode('match-order-skus.js', {
      env, json: { data: [] }, refs: { 'Verify & Normalize Order': { ...order, source: 'webhook' } },
    }).json;
    assert.equal(held.allKnown, false);
    assert.equal(held.salesOrder, null);
    assert.equal(held.holdReasons.length, 2);
  });

  it('Order Held alerts on webhook, stays quiet on poll retries', () => {
    const base = { orderGid: 'gid://shopify/Order/1', orderName: '#1001', skus: ['X'], holdReasons: ['Unknown SKU X'] };
    const fromWebhook = runCodeNode('result-order-held.js', { json: { ...base, source: 'webhook' } }).json;
    const fromPoll = runCodeNode('result-order-held.js', { json: { ...base, source: 'poll' } }).json;
    assert.match(fromWebhook.slack_text, /#1001 is ON HOLD/);
    assert.equal(fromPoll.slack_text, null);
    assert.equal(fromPoll.status, 'failed');
  });
});

describe('LS-04 code nodes', () => {
  it('Result: Product Created reports userErrors as a failure', () => {
    const out = runCodeNode('result-product-created.js', {
      json: { data: { productSet: { product: null, userErrors: [{ field: ['input', 'title'], message: "can't be blank" }] } } },
      refs: { 'Build Shopify Product': { sku: 'S-0108-0901-10' } },
    }).json;
    assert.equal(out.status, 'failed');
    assert.match(out.error_message, /input.title: can't be blank/);
  });

  it('Build Shopify Product searches Shopify by the first size and strips helper fields', () => {
    const out = runCodeNode('build-shopify-product.js', { json: { data: {
      name: 'S-0108-0901', item_name: 'Midnight Moons Zippy', item_group: 'Sleep', custom_size_run: 'Newborn|Preemie', custom_retail_price: 36,
    } } }).json;
    assert.equal(out.findVariantBody.variables.q, 'sku:"S-0108-0901-10"'); // Preemie sorts first
    assert.equal(out.variantCount, 2);
    assert.equal('firstSku' in out.productSetBody, false);
  });
});

describe('LS-05 safety-net poll', () => {
  const order = (n) => ({ id: `gid://shopify/Order/${n}`, name: `#${n}`, lineItems: { nodes: [] } });

  // Fake Shopify: `total` recent orders served 25 per page; nodes(ids) answers from `known`.
  function fakeShopify({ total, known = {}, throttleFirst = 0 }) {
    const calls = [];
    let throttles = throttleFirst;
    const graphql = async (query, variables) => {
      calls.push({ query: query.includes('ordersById') ? 'byId' : 'recent', variables });
      if (throttles > 0) { throttles--; return { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }; }
      if (query.includes('ordersById')) return { data: { nodes: variables.ids.map((id) => known[id] ?? null) } };
      const start = variables.after ? Number(variables.after) : 0;
      const nodes = Array.from({ length: Math.min(25, total - start) }, (_, i) => order(start + i + 1));
      const end = start + nodes.length;
      return { data: { orders: { nodes, pageInfo: { hasNextPage: end < total, endCursor: String(end) } } } };
    };
    return { graphql, calls };
  }

  it('classifySyncState: imported = success/skipped, retry = failed imports (not signature failures)', () => {
    const s = lib.classifySyncState([
      { order_gid: 'a', status: 'success', action: 'import_order' },
      { order_gid: 'b', status: 'skipped', action: 'import_order' },
      { order_gid: 'c', status: 'failed', action: 'import_order' },
      { order_gid: 'd', status: 'failed', action: 'verify_signature' },
      {},
    ]);
    assert.deepEqual([...s.imported].sort(), ['a', 'b']);
    assert.deepEqual(plain(s.retry), ['c']);
  });

  it('pages through every recent order (the old poll only ever saw the oldest 50)', async () => {
    const { graphql, calls } = fakeShopify({ total: 130 });
    const r = await lib.fetchOrdersToReconcile({ graphql, sinceIso: 'X', imported: new Set(), retryGids: [] });
    assert.equal(r.orders.length, 130);
    assert.equal(r.stats.pages, 6);
    assert.equal(calls[1].variables.after, '25');
    assert.equal(r.orders.at(-1).id, 'gid://shopify/Order/130'); // the NEWEST order is reached
  });

  it('skips orders already imported so a busy hour does not re-hit the ERP', async () => {
    const { graphql } = fakeShopify({ total: 30 });
    const imported = new Set(Array.from({ length: 28 }, (_, i) => `gid://shopify/Order/${i + 1}`));
    const r = await lib.fetchOrdersToReconcile({ graphql, sinceIso: 'X', imported, retryGids: [] });
    assert.deepEqual(plain(r.orders.map((o) => o.name)), ['#29', '#30']);
    assert.equal(r.stats.skippedImported, 28);
  });

  it('retries held orders by ID in batches of 25, regardless of the time window', async () => {
    const held = Array.from({ length: 30 }, (_, i) => `gid://shopify/Order/9${i}`);
    const known = Object.fromEntries(held.slice(0, 29).map((id) => [id, { id, name: id, lineItems: { nodes: [] } }]));
    const { graphql, calls } = fakeShopify({ total: 0, known }); // last held order was deleted in Shopify
    const r = await lib.fetchOrdersToReconcile({ graphql, sinceIso: 'X', imported: new Set(), retryGids: held });
    assert.equal(r.stats.retriedById, 29);
    assert.deepEqual(calls.filter((c) => c.query === 'byId').map((c) => c.variables.ids.length), [25, 5]);
  });

  it('backs off on THROTTLED instead of failing', async () => {
    const waits = [];
    const { graphql } = fakeShopify({ total: 3, throttleFirst: 2 });
    const r = await lib.fetchOrdersToReconcile({ graphql, sinceIso: 'X', imported: new Set(), retryGids: [], sleep: async (ms) => waits.push(ms) });
    assert.equal(r.orders.length, 3);
    assert.deepEqual(waits, [2000, 4000]);
  });

  it('stops at maxPages and says so, rather than running forever', async () => {
    const { graphql } = fakeShopify({ total: 1000 });
    const r = await lib.fetchOrdersToReconcile({ graphql, sinceIso: 'X', imported: new Set(), retryGids: [], maxPages: 3 });
    assert.equal(r.stats.truncated, true);
    assert.equal(r.orders.length, 75);
  });
});
