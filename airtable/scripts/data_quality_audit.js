/**
 * Airtable Scripting extension: Colorways data-quality audit
 * -----------------------------------------------------------
 * Run from the Scripting extension (Extensions → Scripting) before a launch review.
 * Finds problems BEFORE they become failed syncs, and optionally re-queues fixed ones.
 *
 * Checks (same rules as n8n LS-01 / LS-06; shared/product_model.json):
 *   - colorway number must be 4 digits, and unique per style
 *   - style and print linked; the style has a size run
 *   - approved colorways have a cost and a launch date
 *   - SKU bases (written by LS-06) are unique
 *   - "Error" colorways whose data now looks fixed (offer to set Sync Status = Pending)
 */
const table = base.getTable('Colorways');
const query = await table.selectRecordsAsync({
  fields: ['Colorway', 'Style', 'Print', 'Colorway Number', 'Production Status', 'Compliance Status',
           'Launch Date', 'Cost Price', 'SKU Base', 'Sync Status'],
});
const styles = await base.getTable('Style Master').selectRecordsAsync({ fields: ['Style Number', 'Size Run'] });

const issues = [];
const fixedErrors = [];
const colorwayNumbers = new Map(); // style id + colorway number → colorway name
const skuBases = new Map();

for (const r of query.records) {
  const get = (f) => r.getCellValue(f);
  const name = (f) => (get(f) && get(f).name) || null; // single select → option name
  const label = get('Colorway') || r.id;
  const style = (get('Style') || [])[0];
  const problems = [];

  if (!style) problems.push('no style linked');
  if (!(get('Print') || []).length) problems.push('no print linked');
  const number = String(get('Colorway Number') || '').trim();
  if (!/^\d{4}$/.test(number)) problems.push(`colorway number "${number}" must be 4 digits`);
  if (style) {
    const styleRecord = styles.getRecord(style.id);
    if (!(styleRecord.getCellValue('Size Run') || []).length) problems.push(`style ${style.name} has no size run`);
    const key = `${style.id}:${number}`;
    if (number && colorwayNumbers.has(key)) problems.push(`colorway number ${number} also used by ${colorwayNumbers.get(key)} on this style`);
    colorwayNumbers.set(key, label);
  }
  if (name('Production Status') === 'Approved for Production') {
    if (!(get('Cost Price') > 0)) problems.push('missing/zero Cost Price');
    if (!get('Launch Date')) problems.push('missing Launch Date');
  }
  const sku = get('SKU Base');
  if (sku && skuBases.has(sku)) problems.push(`SKU base ${sku} also used by ${skuBases.get(sku)}`);
  if (sku) skuBases.set(sku, label);

  if (name('Sync Status') === 'Error' && problems.length === 0 && name('Compliance Status') === 'Passed') fixedErrors.push(r);
  if (problems.length) issues.push({ Colorway: label, Issues: problems.join('; ') });
}

output.markdown(`## Colorways data-quality audit\nChecked **${query.records.length}** colorways. Found **${issues.length}** with issues.`);
if (issues.length) output.table(issues);

if (fixedErrors.length) {
  output.markdown(`**${fixedErrors.length}** colorways are in *Error* but now pass every check.`);
  const choice = await input.buttonsAsync('Set them to Pending so n8n retries?', ['Yes, retry', 'No']);
  if (choice === 'Yes, retry') {
    const updates = fixedErrors.map((r) => ({ id: r.id, fields: { 'Sync Status': { name: 'Pending' } } }));
    while (updates.length) await table.updateRecordsAsync(updates.splice(0, 50)); // 50-record batch limit
    output.markdown('Queued for retry. The LS-01 safety-net poll will pick them up.');
  }
}
