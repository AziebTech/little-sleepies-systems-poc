// Mode: Run Once for All Items
// Webhook branch sends { body: { name } }; poll branch sends { data: [{ name }] }.
// A Set only keeps unique values, so a PO seen twice is only processed once.
const names = new Set();
// Go through every incoming item, looking only at its "json" part.
for (const { json } of $input.all()) {
  // Webhook shape: the PO name is in body.name.
  if (json.body && json.body.name) names.add(json.body.name);
  // Poll shape: a list of POs in "data"; add each one's name (skip blanks).
  if (Array.isArray(json.data)) json.data.forEach((r) => r.name && names.add(r.name));
}
// Turn the Set back into a list and send out one item per PO name.
return [...names].map((name) => ({ json: { po_name: name } }));
