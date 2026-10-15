// Mode: Run Once for All Items
// One output item per (PO, colorway): size-variant lines roll up to the colorway that
// Production tracks in Airtable, with a per-size breakdown.
// @include lib/product-model.js
// @include lib/sync-helpers.js

// The list of items this node will output.
const out = [];
// Go through each incoming Purchase Order; idx is its position (0, 1, 2…).
$input.all().forEach((item, idx) => {
  // The PO can arrive wrapped in "data" or on its own; handle both.
  const po = item.json.data || item.json;
  // Split the PO into one row per colorway. "pairedItem" tells n8n which input
  // item each output came from, so later nodes can look back at it.
  for (const line of explodePurchaseOrder(po)) out.push({ json: line, pairedItem: { item: idx } });
});
// Send all the rows on to the next node.
return out;
