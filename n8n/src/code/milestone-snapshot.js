// Mode: Run Once for All Items
// One warehouse row per colorway × milestone, sent as a single JSON array so the whole
// snapshot is one INSERT (jsonb_to_recordset) instead of hundreds of round trips.
// For each colorway (c), make one row per milestone (m), then flatten into one long list.
const rows = $input.all().flatMap(({ json: c }) => c.milestones.map((m) => ({
  // Colorway details, repeated on each of its milestone rows.
  colorway_record_id: c.recordId,
  colorway_name: c.colorwayName,
  sku_base: c.skuBase,
  launch_date: c.launchDate,
  // Milestone details.
  milestone: m.key,
  owner_team: m.team,
  due_date: m.due,
  completed_on: m.completedOn,
  status: m.status,
  days_late: m.daysLate,
})));
// If there are rows, send ONE item holding them all as JSON text. If none, send nothing.
return rows.length ? [{ json: { rows: JSON.stringify(rows), count: rows.length } }] : [];
