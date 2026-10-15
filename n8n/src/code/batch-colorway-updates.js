// Mode: Run Once for All Items
// Only colorways whose computed fields changed, 10 per request (Airtable's batch limit).
// No changes → no items → the PATCH node doesn't run (zero API calls on a quiet day).
// @include lib/product-model.js

// Take every item that came into this node...
const updates = $input.all()
  // ...keep only the ones that actually have something to change ("patch")...
  .filter((i) => i.json.patch)
  // ...and turn each one into the shape Airtable wants: { id, fields }.
  .map((i) => ({ id: i.json.recordId, fields: i.json.patch }));
// Split the list into groups of 10 and send out one item per group.
// "typecast: true" lets Airtable convert values (e.g. text → date) for us.
return chunk(updates, 10).map((records) => ({ json: { records, typecast: true } }));
