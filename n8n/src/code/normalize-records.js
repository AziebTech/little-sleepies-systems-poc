// Mode: Run Once for All Items
// Accepts either a single Airtable record ({ id, fields }) from the webhook branch
// or a list response ({ records: [...] }) from the safety-net poll, and emits one
// item per record. De-dupes so a webhook and a poll racing each other sync once.
// Record IDs already handled in this run.
const seen = new Set();
// The list of items this node will output.
const out = [];
// Go through each incoming item; idx is its position (0, 1, 2…).
$input.all().forEach((item, idx) => {
  // Short name for the item's data.
  const j = item.json;
  // A list response? Use its records. A single record? Wrap it in a list. Neither? Empty list.
  const records = Array.isArray(j.records) ? j.records : j.id && j.fields ? [j] : [];
  // Go through each record.
  for (const r of records) {
    // Already handled this record? Skip it.
    if (seen.has(r.id)) continue;
    // Remember it so we skip it next time.
    seen.add(r.id);
    // Output it in one consistent shape, linked back to the input item it came from.
    out.push({ json: { recordId: r.id, fields: r.fields || {} }, pairedItem: { item: idx } });
  }
});
// Send all the records on to the next node.
return out;
