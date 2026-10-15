import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadLib, plain } from './helpers.mjs';

const lib = loadLib('product-model.js', 'sync-helpers.js');

describe('summarizeHttpError', () => {
  it('classifies an ERPNext duplicate (409) with the server message', () => {
    const body = JSON.stringify({
      exc_type: 'DuplicateEntryError',
      _server_messages: JSON.stringify([JSON.stringify({ message: 'Item S-0108-0901-10 already exists' })]),
    });
    const r = plain(lib.summarizeHttpError({ error: { message: `409 - ${body}`, httpCode: '409' } }));
    assert.equal(r.httpStatus, 409);
    assert.equal(r.category, 'duplicate');
    assert.equal(r.retryable, false);
    assert.equal(r.excType, 'DuplicateEntryError');
    assert.match(r.message, /already exists/);
  });

  it('parses the real n8n 2.39.6 error shape (body as an escaped JSON string literal)', () => {
    // Captured from an end-to-end run: HTTP Request node error output against ERPNext.
    const erpBody = JSON.stringify({
      exc_type: 'LinkValidationError',
      _server_messages: JSON.stringify([JSON.stringify({ message: 'Could not find Item Group: Playwear' })]),
    });
    const r = plain(lib.summarizeHttpError({
      data: [],
      error: { message: `417 - ${JSON.stringify(erpBody)}`, name: 'AxiosError', stack: 'AxiosError: Request failed with status code 417' },
    }));
    assert.equal(r.httpStatus, 417);
    assert.equal(r.category, 'validation');
    assert.equal(r.excType, 'LinkValidationError');
    assert.equal(r.message, 'HTTP 417 — LinkValidationError — Could not find Item Group: Playwear');
  });

  it('reads Airtable-style error bodies too', () => {
    const body = JSON.stringify({ error: { type: 'UNKNOWN_FIELD_NAME', message: 'Unknown field name: "Last Synced At"' } });
    const r = lib.summarizeHttpError({ error: { message: `422 - ${JSON.stringify(body)}` } });
    assert.equal(r.excType, 'UNKNOWN_FIELD_NAME');
    assert.match(r.message, /Unknown field name/);
  });

  it('strips the status prefix from plain-text bodies', () => {
    assert.equal(lib.summarizeHttpError({ error: { message: '502 - "Bad Gateway"' } }).message, 'HTTP 502 — Bad Gateway');
    assert.equal(lib.summarizeHttpError({ error: { message: '502 - "\\"Bad Gateway\\""' } }).message, 'HTTP 502 — Bad Gateway');
  });

  it('treats 417 as a validation error (e.g. LinkValidationError for a missing Item Group)', () => {
    const r = lib.summarizeHttpError({ error: { message: '417 - {"exc_type": "LinkValidationError"}' } });
    assert.equal(r.category, 'validation');
    assert.equal(r.excType, 'LinkValidationError');
  });

  it('marks 5xx and network failures as retryable', () => {
    assert.equal(lib.summarizeHttpError({ error: { message: '502 - Bad Gateway' } }).retryable, true);
    const net = lib.summarizeHttpError({ error: { message: 'connect ECONNREFUSED 172.18.0.5:8080' } });
    assert.equal(net.category, 'network');
    assert.equal(net.retryable, true);
  });

  it('maps 401 to auth so the runbook points at credential rotation', () => {
    assert.equal(lib.summarizeHttpError({ error: { httpCode: 401, message: 'Unauthorized' } }).category, 'auth');
  });
});

describe('syncWriteback', () => {
  it('marks success as Synced and clears the error', () => {
    const r = plain(lib.syncWriteback({ status: 'success', erpItemCode: 'S-0108-0901', nowIso: 'T' }));
    assert.deepEqual(r, {
      fields: { 'Sync Status': 'Synced', 'ERP Item Code': 'S-0108-0901', 'Last Sync Error': '', 'Last Synced At': 'T' },
      typecast: true,
    });
  });

  it('marks failures as Error without touching ERP Item Code', () => {
    const r = plain(lib.syncWriteback({ status: 'failed', errorMessage: 'boom', nowIso: 'T' }));
    assert.equal(r.fields['Sync Status'], 'Error');
    assert.equal('ERP Item Code' in r.fields, false);
  });

  it('sends transient failures back to Pending so the safety-net poll retries them', () => {
    const r = lib.syncWriteback({ status: 'failed', errorMessage: 'HTTP 502', retryable: true, nowIso: 'T' });
    assert.equal(r.fields['Sync Status'], 'Pending');
  });
});

describe('airtableEquals', () => {
  it('escapes quotes so a value cannot break out of the formula', () => {
    assert.equal(lib.airtableEquals('ERP Item Code', "x' OR 1=1 OR '"), "{ERP Item Code}='x\\' OR 1=1 OR \\''");
  });
});

describe('explodePurchaseOrder', () => {
  it('rolls size-variant lines up to the colorway, with a per-size breakdown', () => {
    const rows = plain(lib.explodePurchaseOrder({
      name: 'PUR-ORD-2026-00020', supplier: 'Sunrise Textile Co.', status: 'To Receive and Bill', docstatus: 1,
      items: [
        { item_code: 'S-0108-0901-10', qty: 100, schedule_date: '2026-12-01' },
        { item_code: 'S-0108-0901-08', qty: 50, schedule_date: '2026-11-15' },
        { item_code: 'D-0060-0906-34', qty: 75, schedule_date: '2027-01-10' },
      ],
    }));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].item_code, 'S-0108-0901');
    assert.equal(rows[0].qty, 150);
    assert.equal(rows[0].expected_delivery, '2026-11-15');
    assert.equal(rows[0].airtable_fields['PO Size Breakdown'], 'Preemie ×100, 3T ×50');
    assert.equal(rows[1].airtable_formula, "{ERP Item Code}='D-0060-0906'");
    assert.equal(rows[1].airtable_fields['PO Size Breakdown'], '0-3 months ×75'); // Play size code 34
  });

  it('passes legacy item codes through unchanged', () => {
    const rows = plain(lib.explodePurchaseOrder({ name: 'PO-1', supplier: 'S', items: [{ item_code: 'LEGACY-ITEM-001', qty: 5 }] }));
    assert.equal(rows[0].item_code, 'LEGACY-ITEM-001');
    assert.equal(rows[0].airtable_fields['PO Size Breakdown'], null);
  });
});
