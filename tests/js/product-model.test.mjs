import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadLib, plain, ROOT, runCodeNode } from './helpers.mjs';

const lib = loadLib('product-model.js');
const cases = JSON.parse(readFileSync(join(ROOT, 'shared', 'product_model_cases.json'), 'utf8'));
const TODAY = '2026-10-08';

describe('parseCost (shared cases)', () => {
  for (const { raw, expected } of cases.cost) {
    it(`${JSON.stringify(raw)} -> ${expected}`, () => assert.equal(lib.parseCost(raw), expected));
  }
});

describe('v2 SKU rules (shared cases)', () => {
  for (const c of cases.buildBase) {
    it(`base ${c.division}/${c.style}/${c.colorway} -> ${c.expected}`, () =>
      assert.equal(lib.buildSkuBase({ division: c.division, styleNumber: c.style, colorwayNumber: c.colorway }), c.expected));
  }
  for (const c of cases.parse) {
    it(`parse ${JSON.stringify(c.sku)}`, () => assert.deepEqual(plain(lib.parseSku(c.sku)), c.expected));
  }
  for (const c of cases.variants) {
    it(`variants of ${c.base}`, () => {
      const r = plain(lib.sizeRunSkus(c.base, c.sizes));
      assert.deepEqual(r.variants.map((v) => v.sku), c.expected);
      assert.deepEqual(r.unknown, c.unknown);
    });
  }
  it('orders variants by size, not by size code (3T is 08 but comes after 2T = 12)', () => {
    const r = plain(lib.sizeRunSkus('S-0108-0665', ['3T', '2T', 'Preemie']));
    assert.deepEqual(r.variants.map((v) => v.size), ['Preemie', '2T', '3T']);
  });
});

// ---- critical path fixtures -------------------------------------------------
const zippy = { 'Style Number': '0108', 'Style Name': 'Zippy', Division: 'Sleep', Fabric: 'Lunaluxe', 'Compliance Profile': "Children's Sleepwear" };
const print = { 'Print Name': 'Midnight Moons', License: 'None' };
const passed = (type, date = '2026-08-01') => ({ 'Test Type': type, Status: 'Passed', 'Result Date': date });
const allPassed = (date) => ["Lead (CPSIA)", "Phthalates (CPSIA)", "Snug-Fit Dimensions (16 CFR 1615/1616)", 'Tracking Label', "Children's Product Certificate"].map((t) => passed(t, date));
const ppApproved = (date = '2026-07-01') => ({ Round: 'Pre-Production', Status: 'Approved', 'Decision Date': date });
const cp = (overrides) => plain(lib.computeCriticalPath({
  colorway: { Colorway: 'Midnight Moons Zippy', 'Colorway Number': '0901', 'Launch Date': '2026-12-01', ...overrides.colorway },
  style: 'style' in overrides ? overrides.style : zippy,
  print: 'print' in overrides ? overrides.print : print,
  samples: overrides.samples || [], tests: overrides.tests || [], shots: overrides.shots || [], today: TODAY,
}));

describe('computeCriticalPath', () => {
  it('derives the SKU base and milestone due dates from the launch date', () => {
    const r = cp({});
    assert.equal(r.fields['SKU Base'], 'S-0108-0901');
    assert.deepEqual(r.milestones.map((m) => [m.key, m.due]), [
      ['sample', '2026-09-02'], ['compliance', '2026-10-02'], ['photo', '2026-11-01'], ['erp', '2026-11-10'],
    ]);
  });

  it('is Late when a milestone is overdue, and reports the worst lateness', () => {
    // sample due 09-02 (36 days ago) and compliance due 10-02 (6 days ago), neither done
    const r = cp({});
    assert.equal(r.fields['Timeline Status'], 'Late');
    assert.equal(r.fields['Days Late'], 36);
    assert.equal(r.fields['Next Milestone'], 'Pre-production sample approved (Production), due 2026-09-02');
  });

  it('is At Risk when the next milestone is due within 7 days', () => {
    const r = cp({ colorway: { 'Launch Date': '2026-12-10' }, samples: [ppApproved('2026-09-01')] }); // compliance due 10-11
    assert.equal(r.fields['Timeline Status'], 'At Risk');
    assert.equal(r.fields['Sample Status'], 'Approved');
  });

  it('is On Track when everything open is more than a week away', () => {
    const r = cp({ colorway: { 'Launch Date': '2027-03-01' } });
    assert.equal(r.fields['Timeline Status'], 'On Track');
    assert.equal(r.fields['Days Late'], 0);
  });

  it('is Complete when every milestone is done, and records late completions', () => {
    const r = cp({
      colorway: { 'Launch Date': '2026-10-01', 'Sync Status': 'Synced', 'Last Synced At': '2026-09-05T10:00:00.000Z' },
      samples: [ppApproved('2026-07-01')], tests: allPassed('2026-08-15'),
      shots: [{ Status: 'Delivered', 'Delivered Date': '2026-09-05' }],
    });
    assert.equal(r.fields['Timeline Status'], 'Complete');
    const photo = r.milestones.find((m) => m.key === 'photo');
    assert.deepEqual([photo.status, photo.daysLate], ['done_late', 4]); // due 09-01, delivered 09-05
  });

  it('requires every test the compliance profile lists, and names the missing ones', () => {
    const r = cp({ tests: [passed('Lead (CPSIA)'), passed('Tracking Label')] });
    assert.equal(r.fields['Compliance Status'], 'In Testing');
    // Partial progress is not completion: no date until every required test has passed.
    assert.equal(r.milestones.find((m) => m.key === 'compliance').completedOn, null);
    assert.match(r.fields['Critical Path'], /Waiting on: Phthalates \(CPSIA\), Snug-Fit/);
  });

  it('a failed test blocks compliance (At Risk until overdue, then Late)', () => {
    const tests = [...allPassed().slice(1), { 'Test Type': 'Lead (CPSIA)', Status: 'Failed', 'Result Date': '2026-08-01' }];
    const early = cp({ colorway: { 'Launch Date': '2027-03-01' }, tests, samples: [ppApproved()] });
    assert.equal(early.fields['Compliance Status'], 'Failed');
    assert.equal(early.fields['Timeline Status'], 'At Risk');
    assert.match(early.fields['Critical Path'], /⛔ Compliance tests passed: .*Failed: Lead \(CPSIA\)/);
    const overdue = cp({ tests, samples: [ppApproved()] });
    assert.equal(overdue.fields['Timeline Status'], 'Late');
  });

  it('a later retest that passes clears an earlier failure', () => {
    const tests = [{ 'Test Type': 'Lead (CPSIA)', Status: 'Failed', 'Result Date': '2026-07-01' }, ...allPassed('2026-08-01')];
    assert.equal(cp({ tests }).fields['Compliance Status'], 'Passed');
  });

  it('adds a licensor-approval milestone only for licensed prints', () => {
    const r = cp({ print: { ...print, License: 'Licensed', 'Licensor Approval': 'Changes Requested' } });
    const license = r.milestones.find((m) => m.key === 'license');
    assert.equal(license.team, 'Product');
    assert.equal(license.status, 'blocked');
    assert.equal(cp({}).milestones.some((m) => m.key === 'license'), false);
  });

  it('flags data problems instead of guessing', () => {
    const r = cp({ colorway: { 'Colorway Number': '91', 'Launch Date': '2027-03-01' }, style: { ...zippy, Fabric: 'Soluxe' } });
    assert.equal(r.fields['SKU Base'], '');
    assert.equal(r.fields['Timeline Status'], 'At Risk'); // dates fine, but the bad SKU will block the ERP sync
    assert.match(r.fields['Critical Path'], /⚠ Data: Colorway Number "91" must be 4 digits/);
    assert.match(r.fields['Critical Path'], /Sleep styles should be Lunaluxe, not Soluxe/);
    assert.equal(cp({ style: null }).issues[0], 'No style linked');
  });

  it('has no due dates without a launch date', () => {
    const r = cp({ colorway: { 'Launch Date': null } });
    assert.equal(r.fields['Timeline Status'], 'No Launch Date');
    assert.equal(r.fields['Next Due Date'], null);
  });
});

describe('diffFields + buildTeamDigest', () => {
  it('only returns changed fields, treating empty and missing alike', () => {
    assert.equal(lib.diffFields({ A: 'x', B: '' }, { A: 'x', B: null }), null);
    assert.deepEqual(plain(lib.diffFields({ A: 'x' }, { A: 'y', B: 0 })), { A: 'y', B: 0 });
  });

  it('groups late and at-risk milestones by team in one message', () => {
    const results = [
      { colorwayName: 'Woodland Fox Zippy', skuBase: 'S-0108-0907', milestones: [
        { team: 'Photography', label: 'Photography delivered', status: 'open_late', due: '2026-09-25', daysLate: 13 },
        { team: 'Systems', label: 'Synced to the ERP', status: 'open_at_risk', due: '2026-10-12', daysLate: 0 },
      ] },
      { colorwayName: 'Sage Botanicals Zippy', skuBase: 'S-0108-0905', milestones: [
        { team: 'Photography', label: 'Photography delivered', status: 'open_at_risk', due: '2026-10-14', daysLate: 0 },
        { team: 'Production', label: 'Pre-production sample approved', status: 'done_on_time', due: '2026-08-01', daysLate: 0 },
      ] },
    ];
    const text = lib.buildTeamDigest(results);
    assert.match(text, /\*Photography\*: 1 late, 1 at risk/);
    assert.match(text, /\*Systems\*: 0 late, 1 at risk/);
    assert.doesNotMatch(text, /Production/);
    assert.ok(text.indexOf('Woodland Fox') < text.indexOf('Sage Botanicals')); // most late first
    assert.equal(lib.buildTeamDigest([{ colorwayName: 'x', milestones: [] }]), null);
  });

  it('counts a blocked milestone as at risk until it is overdue (same rule as the timeline)', () => {
    const blocked = (daysLate) => [{ colorwayName: 'Moons Pants', milestones: [
      { team: 'Production', label: 'Pre-production sample approved', status: 'blocked', due: '2026-10-18', daysLate, note: 'Last PP sample rejected' }] }];
    assert.match(lib.buildTeamDigest(blocked(0)), /\*Production\*: 0 late, 1 at risk/);
    assert.match(lib.buildTeamDigest(blocked(3)), /\*Production\*: 1 late, 0 at risk/);
  });

  it('lists data issues in their own section', () => {
    const text = lib.buildTeamDigest([{ colorwayName: 'Dino Dig Men\'s Pajama Top', milestones: [], issues: ['Colorway Number "91" must be 4 digits'] }]);
    assert.match(text, /\*Data issues\* \(fix in Airtable\): 1\n  ⚠ Dino Dig Men's Pajama Top: Colorway Number "91"/);
  });
});

describe('LS-06 code nodes', () => {
  it('Compute Critical Path joins linked records across paginated loads', () => {
    const page = (records) => ({ records });
    const out = runCodeNode('compute-critical-path.js', { refsAll: {
      'Load Colorways': [
        page([{ id: 'recCW1', fields: { Colorway: 'Midnight Moons Zippy', Style: ['recST1'], Print: ['recPR1'], 'Colorway Number': '0901', 'Launch Date': '2030-01-01' } }]),
        page([{ id: 'recCW2', fields: { Colorway: 'Cancelled one', 'Production Status': 'Cancelled' } }]), // 2nd page
      ],
      'Load Style Master': [page([{ id: 'recST1', fields: zippy }])],
      'Load Prints': [page([{ id: 'recPR1', fields: print }])],
      'Load Samples': [page([{ id: 'recSA1', fields: { ...ppApproved(), Colorway: ['recCW1'] } }])],
      'Load Compliance Tests': [page([])],
      'Load Photo Shots': [page([])],
    } });
    assert.equal(out.length, 1); // cancelled colorway skipped
    assert.equal(out[0].json.skuBase, 'S-0108-0901');
    assert.equal(out[0].json.patch['Sample Status'], 'Approved');
    assert.equal(out[0].json.timeline, 'On Track');
  });

  it('Batch Colorway Updates sends only changed records, 10 per request', () => {
    const items = Array.from({ length: 23 }, (_, i) => ({ recordId: `rec${i}`, patch: i % 2 ? { A: i } : null }));
    const out = runCodeNode('batch-colorway-updates.js', { items });
    assert.deepEqual(out.map((o) => o.json.records.length), [10, 1]);
    assert.equal(out[0].json.typecast, true);
  });

  it('Milestone Snapshot emits a single row set, or nothing', () => {
    const out = runCodeNode('milestone-snapshot.js', { items: [{ recordId: 'r', colorwayName: 'c', skuBase: 's', launchDate: '2027-01-01',
      milestones: [{ key: 'sample', team: 'Production', due: '2026-10-03', completedOn: null, status: 'open_late', daysLate: 5 }] }] });
    assert.equal(out[0].json.count, 1);
    assert.equal(JSON.parse(out[0].json.rows)[0].owner_team, 'Production');
    assert.deepEqual(runCodeNode('milestone-snapshot.js', { items: [] }), []);
  });
});

describe('transformColorway (LS-01)', () => {
  const sizeRows = {
    sz10: { Division: 'Sleep', 'Size Label': 'Preemie', 'Size Code': '10', 'Sort Order': 1 },
    sz08: { Division: 'Sleep', 'Size Label': '3T', 'Size Code': '08', 'Sort Order': 9 },
    sz12: { Division: 'Sleep', 'Size Label': '2T', 'Size Code': '12', 'Sort Order': 8 },
    szD34: { Division: 'Play', 'Size Label': '0-3 months', 'Size Code': '34', 'Sort Order': 1 },
  };
  const lookups = (styleOverrides = {}) => ({
    styles: new Map([['recST', { ...zippy, 'Style Name': 'Zippy', 'Product Type': 'Zippy', 'Retail Price': 36,
      'Fiber Content': '95% viscose from bamboo, 5% spandex', 'Size Run': ['sz08', 'sz10', 'sz12'], ...styleOverrides }]]),
    prints: new Map([['recPR', { 'Print Name': 'Midnight Moons', Slug: 'midnight-moons', 'Print Category': 'Celestial' }]]),
    sizeCodes: new Map(Object.entries(sizeRows)),
  });
  const ready = (overrides = {}) => ({ recordId: 'recCW', fields: {
    Colorway: 'Midnight Moons Zippy', Style: ['recST'], Print: ['recPR'], 'Colorway Number': '0901',
    'Production Status': 'Approved for Production', 'Compliance Status': 'Passed', 'Launch Date': '2027-01-16',
    'Cost Price': 9.8, 'Inventory Tier': 1, 'Limited Edition': true, 'Purchase Limit': 5, ...overrides } });

  it('builds an ERPNext template plus a size-variant request in size order', () => {
    const r = plain(lib.transformColorway(ready(), lookups()));
    assert.equal(r.valid, true);
    assert.equal(r.skuBase, 'S-0108-0901');
    assert.deepEqual(r.sizes, ['Preemie', '2T', '3T']);
    assert.equal(r.templatePayload.item_code, 'S-0108-0901');
    assert.equal(r.templatePayload.has_variants, 1);
    assert.deepEqual(r.templatePayload.attributes, [{ attribute: 'Size (Sleep)' }]);
    assert.equal(r.templatePayload.item_group, 'Sleep');
    assert.equal(r.templatePayload.custom_size_run, 'Preemie|2T|3T');
    assert.equal(r.templatePayload.custom_limited_edition, 1);
    assert.deepEqual(r.variantRequest, { item: 'S-0108-0901', args: JSON.stringify({ 'Size (Sleep)': ['Preemie', '2T', '3T'] }) });
  });

  it('never sends template-only fields on update (ERPNext rejects them once variants exist)', () => {
    const r = plain(lib.transformColorway(ready(), lookups()));
    for (const k of ['item_code', 'has_variants', 'attributes', 'variant_based_on']) assert.equal(k in r.updatePayload, false, k);
  });

  it('waits for compliance and production approval', () => {
    const r = plain(lib.transformColorway(ready({ 'Compliance Status': 'In Testing', 'Production Status': 'In Development' }), lookups()));
    assert.equal(r.valid, false);
    assert.equal(r.errors.length, 2);
    assert.match(r.errors[1], /every required test must pass first/);
  });

  it('rejects sizes from another division and sizes with no code', () => {
    const r = plain(lib.transformColorway(ready(), lookups({ 'Size Run': ['sz10', 'szD34'] })));
    assert.match(r.errors.join(), /Size Run includes non-Sleep sizes: 0-3 months/);
    const empty = plain(lib.transformColorway(ready(), lookups({ 'Size Run': [] })));
    assert.match(empty.errors.join(), /has no Size Run/);
  });

  it('collects every data problem at once', () => {
    const r = plain(lib.transformColorway(ready({ 'Colorway Number': '91', 'Cost Price': '12.5O', 'Launch Date': null }), lookups({ 'Retail Price': null })));
    assert.equal(r.errors.length, 4);
    assert.equal(r.templatePayload, null);
  });
});
