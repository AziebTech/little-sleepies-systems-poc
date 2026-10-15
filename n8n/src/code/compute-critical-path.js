// Mode: Run Once for All Items
// Joins Colorways with their Style, Print, Samples, Compliance Tests and Photo Shots
// (Airtable link fields hold record IDs) and computes each colorway's critical path.
// Each "Load …" node may return several items: one per page of Airtable results.
// @include lib/product-model.js

// Helper: get every Airtable record from a node, joining all its pages into one list.
const records = (node) => $(node).all().flatMap((i) => i.json.records || []);
// Helper: build a lookup table "record id → fields" for a node, for quick finds by ID.
const byId = (node) => new Map(records(node).map((r) => [r.id, r.fields]));
// Helper: group child records (samples, tests, shots) by the colorway they belong to.
const childrenByColorway = (node) => {
  // The lookup table we're building: colorway id → list of child records.
  const map = new Map();
  // Look at every child record...
  for (const r of records(node)) {
    // ...and every colorway it links to (a link field is a list of record IDs).
    for (const cwId of r.fields.Colorway || []) {
      // First time we see this colorway? Start an empty list for it.
      if (!map.has(cwId)) map.set(cwId, []);
      // Add this child record to that colorway's list.
      map.get(cwId).push(r.fields);
    }
  }
  // Hand back the finished lookup table.
  return map;
};

// Build all the lookup tables once, up front.
const styles = byId('Load Style Master');
const prints = byId('Load Prints');
const samples = childrenByColorway('Load Samples');
const tests = childrenByColorway('Load Compliance Tests');
const shots = childrenByColorway('Load Photo Shots');
// Today's date as "YYYY-MM-DD" (the first 10 characters of the ISO timestamp).
const today = new Date().toISOString().slice(0, 10);

// The list of items this node will output.
const out = [];
// Work through every colorway.
for (const cw of records('Load Colorways')) {
  // Short name for this colorway's fields.
  const f = cw.fields;
  // Skip cancelled colorways: nothing to track.
  if (f['Production Status'] === 'Cancelled') continue;
  // Work out the milestones, dates and status for this colorway.
  const result = computeCriticalPath({
    colorway: f,
    // The colorway's linked style (first linked ID), or null if none.
    style: styles.get((f.Style || [])[0]) || null,
    // The colorway's linked print (first linked ID), or null if none.
    print: prints.get((f.Print || [])[0]) || null,
    // This colorway's samples, tests and photo shots (empty list if none).
    samples: samples.get(cw.id) || [],
    tests: tests.get(cw.id) || [],
    shots: shots.get(cw.id) || [],
    today,
  });
  // Add one output item for this colorway.
  out.push({ json: {
    recordId: cw.id,
    // Use the colorway's name, or its record ID if it has no name.
    colorwayName: f.Colorway || cw.id,
    skuBase: result.fields['SKU Base'] || null,
    launchDate: f['Launch Date'] || null,
    timeline: result.fields['Timeline Status'],
    // Only the fields that changed (null if nothing changed), so we don't write needlessly.
    patch: diffFields(f, result.fields),
    // One row per milestone, used later for the warehouse snapshot and Slack digest.
    milestones: result.milestones,
    // Data problems found (e.g. no style linked).
    issues: result.issues,
  } });
}
// Send all the colorway items on to the next node.
return out;
