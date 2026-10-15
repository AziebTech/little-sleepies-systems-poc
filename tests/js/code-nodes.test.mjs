// Runs the exact code that ships inside the n8n Code nodes, with n8n globals mocked.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCodeNode } from './helpers.mjs';

const ctx = {
  recordId: 'recABC', colorwayName: 'Midnight Moons Zippy', skuBase: 'S-0108-0901', valid: true, errors: [],
  sizes: ['Preemie', 'Newborn', '3T'], approvedAt: null,
};

describe('LS-01 code nodes', () => {
  it('Normalize Records flattens poll + webhook shapes and de-dupes', () => {
    const out = runCodeNode('normalize-records.js', {
      items: [
        { id: 'rec1', fields: { 'Style ID': 'STY-1' } },
        { records: [{ id: 'rec1', fields: {} }, { id: 'rec2', fields: { 'Style ID': 'STY-2' } }] },
      ],
    });
    assert.deepEqual(out.map((i) => i.json.recordId), ['rec1', 'rec2']);
  });

  it('Result: Synced reports create vs update, and what ERPNext did with the variants', () => {
    const created = runCodeNode('result-synced.js', {
      json: { message: 3 }, // ERPNext created 3 variants inline
      refs: { 'Validate & Build ERP Payload': ctx, 'Find Existing ERP Template': { data: [] } },
    }).json;
    assert.equal(created.action, 'create');
    assert.equal(created.status, 'success');
    assert.equal(created.sku, 'S-0108-0901');
    assert.equal(created.entity_type, 'item_template');
    assert.deepEqual(created.payload, { colorway: 'Midnight Moons Zippy', sizes: 3, variants_created: 3 });
    assert.equal(created.airtable_patch.fields['ERP Item Code'], 'S-0108-0901');

    const updated = runCodeNode('result-synced.js', {
      json: { message: 'queued' }, // 10+ sizes go to a background worker
      refs: { 'Validate & Build ERP Payload': ctx, 'Find Existing ERP Template': { data: [{ name: 'S-0108-0901' }] } },
    }).json;
    assert.equal(updated.action, 'update');
    assert.equal(updated.payload.variants_created, 'queued');
  });

  it('Result: ERP Error writes a categorized failure', () => {
    const out = runCodeNode('result-erp-error.js', {
      json: { error: { message: '417 - {"exc_type": "LinkValidationError"}' } },
      refs: { 'Validate & Build ERP Payload': ctx },
    }).json;
    assert.equal(out.status, 'failed');
    assert.equal(out.http_status, 417);
    assert.equal(out.airtable_patch.fields['Sync Status'], 'Error');
    assert.match(out.airtable_patch.fields['Last Sync Error'], /^ERP validation:/);
  });

  it('Result: ERP Error queues transient failures for automatic retry', () => {
    const out = runCodeNode('result-erp-error.js', {
      json: { error: { message: 'connect ECONNREFUSED 172.18.0.5:8080' } },
      refs: { 'Validate & Build ERP Payload': ctx },
    }).json;
    assert.equal(out.airtable_patch.fields['Sync Status'], 'Pending');
    assert.match(out.airtable_patch.fields['Last Sync Error'], /will retry automatically/);
    assert.equal(out.payload.retryable, true);
  });

  it('Result: Validation Failed joins all errors', () => {
    const out = runCodeNode('result-validation-failed.js', {
      json: { ...ctx, valid: false, errors: ['a', 'b'] },
    }).json;
    assert.equal(out.error_message, 'a; b');
    assert.equal(out.action, 'validate');
  });
});

describe('LS-02 code nodes', () => {
  it('Collect PO Names merges webhook and poll inputs without duplicates', () => {
    const out = runCodeNode('collect-po-names.js', {
      items: [{ body: { name: 'PO-1' } }, { data: [{ name: 'PO-1' }, { name: 'PO-2' }] }],
    });
    assert.deepEqual(out.map((i) => i.json.po_name), ['PO-1', 'PO-2']);
  });

  it('Explode PO Lines unwraps the ERPNext { data } envelope', () => {
    const out = runCodeNode('explode-po-lines.js', {
      items: [{ data: { name: 'PO-1', supplier: 'S', items: [{ item_code: 'A', qty: 2 }] } }],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].json.item_code, 'A');
  });
});

describe('LS-03 health check', () => {
  it('flags stale pipelines and high error rates', () => {
    const out = runCodeNode('evaluate-freshness.js', {
      json: { hours_since_last_success: '30.5', events_24h: '10', failures_24h: '3' },
    }).json;
    assert.equal(out.status, 'breach');
    assert.equal(out.breaches.length, 2);
  });

  it('passes a healthy pipeline', () => {
    const out = runCodeNode('evaluate-freshness.js', {
      json: { hours_since_last_success: 0.5, events_24h: 40, failures_24h: 1 },
    }).json;
    assert.equal(out.status, 'ok');
    assert.equal(out.slack_text, null);
  });

  it('treats "never succeeded" (NULL) as a breach', () => {
    const out = runCodeNode('evaluate-freshness.js', {
      json: { hours_since_last_success: null, events_24h: 0, failures_24h: 0 },
    }).json;
    assert.equal(out.status, 'breach');
  });
});
