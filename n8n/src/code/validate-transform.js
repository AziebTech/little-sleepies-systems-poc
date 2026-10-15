// Mode: Run Once for All Items
// Colorway → ERP style template + size-variant request. Style Master, Prints and Size Codes
// are loaded ONCE per run (the "Load …" nodes run once, paginated) and joined here, rather
// than fetching them per colorway.
// @include lib/product-model.js

// Helper: get every Airtable record from a node, joining all its pages into one list.
const recs = (node) => $(node).all().flatMap((i) => i.json.records || []);
// Helper: build a lookup table "record id → fields" for a node, for quick finds by ID.
const byId = (node) => new Map(recs(node).map((r) => [r.id, r.fields]));
// Build the three lookup tables once, up front.
const lookups = { styles: byId('Load Style Master'), prints: byId('Load Prints'), sizeCodes: byId('Load Size Codes') };

// For each colorway: check it and build the ERP payloads. Output one item per colorway.
return $('Normalize Records').all().map((item) => ({ json: transformColorway(item.json, lookups), pairedItem: { item: 0 } }));
