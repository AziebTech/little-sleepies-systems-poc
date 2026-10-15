// ---- lib/product-model.js -------------------------------------------------
// Product model v2: real Little Sleepies SKU structure + launch critical path.
// Python twin for the SKU rules: python/ls_integrations/product_model.py.
// The line below is replaced at build time with the contents of shared/product_model.json,
// available here as PRODUCT_MODEL (divisions, size codes, compliance profiles, milestones).
// @include-json shared/product_model.json PRODUCT_MODEL

// DIVISION-STYLE-COLORWAY[-SIZE], e.g. S-0108-0665-10 (Sleep, Zippy, colorway 0665, Preemie).
// The colorway number is per style: the same print has a different number on each style.
// Pattern: S, D or O, then 4 digits, then 4 digits, then optionally 2 more digits for the size.
const SKU_PATTERN = /^([SDO])-(\d{4})-(\d{4})(?:-(\d{2}))?$/;

// Turn a division letter (e.g. "S") into its name (e.g. "Sleep"), or null if unknown.
function divisionByCode(code) {
  return Object.keys(PRODUCT_MODEL.divisions).find((d) => PRODUCT_MODEL.divisions[d].code === code) || null;
}

// Build the colorway SKU (e.g. "S-0108-0665") from its parts. Returns null if any part is bad.
function buildSkuBase({ division, styleNumber, colorwayNumber }) {
  // The division's settings (including its letter code).
  const d = PRODUCT_MODEL.divisions[division];
  // Style and colorway numbers as text with spaces trimmed.
  const style = String(styleNumber ?? '').trim();
  const colorway = String(colorwayNumber ?? '').trim();
  // Unknown division, or a number that isn't exactly 4 digits? Can't build a SKU.
  if (!d || !/^\d{4}$/.test(style) || !/^\d{4}$/.test(colorway)) return null;
  // Join the parts with dashes.
  return `${d.code}-${style}-${colorway}`;
}

// Split a SKU into its parts. Returns null if it isn't a valid SKU.
function parseSku(sku) {
  // Check the SKU against the pattern; m holds the matched pieces.
  const m = String(sku ?? '').trim().match(SKU_PATTERN);
  // Didn't match the pattern.
  if (!m) return null;
  // m[1] = division letter, m[2] = style, m[3] = colorway, m[4] = size code (may be missing).
  return { divisionCode: m[1], division: divisionByCode(m[1]), style: m[2], colorway: m[3], sizeCode: m[4] || null };
}

// Variant SKUs for a size run. Size codes depend on the division (0-3 months is 01 in Sleep, 34 in Play).
function sizeRunSkus(skuBase, sizeLabels) {
  // Split the colorway SKU into its parts.
  const parsed = parseSku(skuBase);
  // That division's list of sizes and their codes (empty list if unknown).
  const table = parsed ? PRODUCT_MODEL.sizeCodes[parsed.divisionCode] || [] : [];
  // Sizes we found a code for.
  const variants = [];
  // Sizes we couldn't find a code for.
  const unknown = [];
  // Look up each size label.
  for (const label of sizeLabels || []) {
    const size = table.find((s) => s.label === label);
    // Found: add the full SKU, e.g. "S-0108-0665-10".
    if (size) variants.push({ size: label, sku: `${skuBase}-${size.code}`, sort: size.sort });
    // Not found: note it.
    else unknown.push(label);
  }
  // Put the sizes in their natural order (smallest first).
  variants.sort((a, b) => a.sort - b.sort);
  return { variants, unknown };
}

// Turn a size code (e.g. "10") into its label (e.g. "Preemie"). Falls back to the code.
function sizeLabelFor(divisionCode, sizeCode) {
  const size = (PRODUCT_MODEL.sizeCodes[divisionCode] || []).find((s) => s.code === sizeCode);
  return size ? size.label : sizeCode;
}

// ERPNext Item Attribute per division: the same label has different codes per division
// (0-3 months = 01 in Sleep, 34 in Play), and an attribute value can only have one abbreviation.
function sizeAttributeName(division) {
  // e.g. "Size (Sleep)".
  return `Size (${division})`;
}

// Accepts 18.5, "18.50", "$1,204.99". Returns a 2-dp number, or null if not a positive amount.
function parseCost(raw) {
  // Nothing given.
  if (raw === null || raw === undefined) return null;
  // Numbers stay as they are; text has "$", commas and spaces removed.
  const cleaned = typeof raw === 'number' ? raw : String(raw).replace(/[$,\s]/g, '');
  // Empty, or not a plain number like "12" or "12.50"? Reject it.
  if (cleaned === '' || !/^-?\d*\.?\d+$/.test(String(cleaned))) return null;
  // Convert to a number.
  const n = Number(cleaned);
  // Must be a real number above zero.
  if (!Number.isFinite(n) || n <= 0) return null;
  // Round to cents.
  return Math.round(n * 100) / 100;
}

// ---- colorway → ERP template + size variants (LS-01) ----------------------
// lookups: Maps of Airtable record id → fields for Style Master, Prints and Size Codes.
// The template's item_code is the SKU base; ERPNext names each variant
// template-code + "-" + attribute abbreviation, i.e. exactly S-0108-0665-10.
function transformColorway({ recordId, fields = {} }, { styles, prints, sizeCodes }) {
  // Every problem found. If this stays empty, the colorway is valid.
  const errors = [];
  // The linked style and print (first linked ID), or null if none.
  const style = styles.get((fields.Style || [])[0]) || null;
  const print = prints.get((fields.Print || [])[0]) || null;
  // The colorway name with spaces trimmed.
  const name = String(fields.Colorway || '').trim();

  // Basic checks: approved, compliance passed, and has a name, style and print.
  if (fields['Production Status'] !== 'Approved for Production') errors.push(`Production Status is "${fields['Production Status'] || ''}", expected "Approved for Production"`);
  if (fields['Compliance Status'] !== 'Passed') errors.push(`Compliance Status is "${fields['Compliance Status'] || 'not computed'}": every required test must pass first (see the Critical Path field)`);
  if (!name) errors.push('Colorway name is required');
  if (!style) errors.push('No style linked');
  if (!print) errors.push('No print linked');

  // The division comes from the style (e.g. "Sleep").
  const division = style ? style.Division : null;
  // Build the colorway SKU from the division, style number and colorway number.
  const skuBase = style ? buildSkuBase({ division, styleNumber: style['Style Number'], colorwayNumber: fields['Colorway Number'] }) : null;
  // Couldn't build it? The colorway number must be wrong.
  if (style && !skuBase) errors.push(`Colorway Number "${fields['Colorway Number'] || ''}" must be 4 digits`);
  // Check the fabric is the right one for this division.
  if (style && style.Fabric && !fabricMatchesDivision(division, style.Fabric)) errors.push(`${division} styles should be ${PRODUCT_MODEL.divisions[division].fabric}, not ${style.Fabric}`);

  // The style's sizes: turn each linked size ID into its record, dropping any not found.
  const runRows = style ? (style['Size Run'] || []).map((id) => sizeCodes.get(id)).filter(Boolean) : [];
  // Any sizes that belong to a different division (a data mistake).
  const wrongDivision = runRows.filter((s) => s.Division !== division).map((s) => s['Size Label']);
  // No sizes at all.
  if (style && !runRows.length) errors.push(`Style ${style['Style Number']} has no Size Run`);
  // Sizes from the wrong division.
  if (wrongDivision.length) errors.push(`Size Run includes ${division ? 'non-' + division : 'mismatched'} sizes: ${wrongDivision.join(', ')}`);
  // The correct sizes, in their sort order, as labels (e.g. ["Preemie", "Newborn", …]).
  const sizes = runRows.filter((s) => s.Division === division).sort((a, b) => a['Sort Order'] - b['Sort Order']).map((s) => s['Size Label']);
  // Check every size has a size code.
  const { unknown } = skuBase ? sizeRunSkus(skuBase, sizes) : { unknown: [] };
  if (unknown.length) errors.push(`No size code for ${unknown.join(', ')} in division ${division}`);

  // Cost and retail prices as clean numbers (null if bad).
  const cost = parseCost(fields['Cost Price']);
  const retail = style ? parseCost(style['Retail Price']) : null;
  // Launch date as "YYYY-MM-DD", or null.
  const launch = fields['Launch Date'] ? String(fields['Launch Date']).slice(0, 10) : null;
  // Price and date checks.
  if (cost === null) errors.push('Cost Price must be a positive amount');
  if (style && retail === null) errors.push(`Style ${style['Style Number']} needs a Retail Price`);
  if (!launch) errors.push('Launch Date is required');

  // Valid if no problems were found.
  const valid = errors.length === 0;
  // The ERP size attribute for this division, e.g. "Size (Sleep)".
  const attribute = division ? sizeAttributeName(division) : null;
  // Fields shared by "create" and "update" (only built when valid).
  const common = valid ? {
    // Name cut to 140 characters (ERPNext's limit).
    item_name: name.slice(0, 140),
    item_group: division,
    brand: 'Little Sleepies',
    // "<Print Name> <Style Name>. <Fiber Content>".
    description: `${print['Print Name']} ${style['Style Name']}. ${style['Fiber Content'] || ''}`.trim(),
    valuation_rate: cost,
    // Links back to Airtable so we can find this item again (keeps the sync idempotent).
    custom_airtable_record_id: recordId,
    // The rest are custom fields copied from the style, print and colorway.
    custom_style_id: style['Style Number'],
    custom_colorway_number: String(fields['Colorway Number']).trim(),
    custom_print_name: print['Print Name'],
    custom_print_family: print.Slug || null,
    custom_print_category: print['Print Category'] || null,
    custom_product_type: style['Product Type'] || null,
    custom_fabric_type: style.Fabric || null,
    custom_fiber_content: style['Fiber Content'] || null,
    custom_compliance_profile: style['Compliance Profile'] || null,
    custom_launch_date: launch,
    // Merch date, or the launch date if there isn't one.
    custom_merch_date: fields['Merch Date'] ? String(fields['Merch Date']).slice(0, 10) : launch,
    custom_inventory_tier: fields['Inventory Tier'] ?? null,
    // ERPNext checkboxes use 1/0, not true/false.
    custom_limited_edition: fields['Limited Edition'] ? 1 : 0,
    custom_purchase_limit: fields['Purchase Limit'] ?? null,
    custom_retail_price: retail,
    // Sizes stored as one text field, e.g. "Preemie|Newborn|0-3 Months".
    custom_size_run: sizes.join('|'),
  } : null;

  return {
    recordId,
    colorwayName: name,
    skuBase,
    valid,
    errors,
    sizes,
    approvedAt: null,
    // Template-only fields can't change once variants exist, so updates send `common` only.
    // Full payload for creating a new style template (null if invalid).
    templatePayload: valid ? {
      item_code: skuBase, stock_uom: 'Nos', is_stock_item: 1, is_purchase_item: 1, is_sales_item: 1,
      has_variants: 1, variant_based_on: 'Item Attribute', attributes: [{ attribute }], ...common,
    } : null,
    // Payload for updating an existing template.
    updatePayload: common,
    // erpnext.controllers.item_variant.enqueue_multiple_variant_creation expects args as a JSON string.
    // Request asking ERPNext to create one variant per size (null if invalid).
    variantRequest: valid ? { item: skuBase, args: JSON.stringify({ [attribute]: sizes }) } : null,
  };
}

// The list of compliance tests a profile requires, or null if the profile is unknown.
function requiredTests(profile) {
  return PRODUCT_MODEL.complianceProfiles[profile] || null;
}

// true if the fabric is the one this division expects (or the division has no rule).
function fabricMatchesDivision(division, fabric) {
  const expected = (PRODUCT_MODEL.divisions[division] || {}).fabric;
  return !expected || expected === fabric;
}

// ---- dates (date-only, UTC) ----------------------------------------------
// Add (or with a negative number, subtract) days from a "YYYY-MM-DD" date.
function addDaysIso(iso, days) {
  // Midnight UTC on that date, so time zones can't shift the day.
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  // Back to "YYYY-MM-DD".
  return d.toISOString().slice(0, 10);
}
// Number of days from one date to another (negative if "to" is earlier). 86400000 = ms in a day.
function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`)) / 86400000);
}
// The latest date in a list (ignoring blanks), or null. "YYYY-MM-DD" dates sort correctly as text.
const maxDate = (dates) => dates.filter(Boolean).map((d) => String(d).slice(0, 10)).sort().pop() || null;

// ---- critical path --------------------------------------------------------
// Late = past due and not done. A blocked milestone (failed test, rejected sample) is only
// "late" once it's past due; before that it's a risk. Shared by the timeline and the digest.
const isLate = (m) => m.status === 'open_late' || (m.status === 'blocked' && m.daysLate > 0);
// Inputs are Airtable `fields` objects. Returns the Colorway fields to write back and one
// row per milestone (for the warehouse snapshot and the team digest).
function computeCriticalPath({ colorway, style, print, samples = [], tests = [], shots = [], today }) {
  // Data problems found along the way.
  const issues = [];
  if (!style) issues.push('No style linked');
  if (!print) issues.push('No print linked');
  // Build the colorway SKU (null if we can't).
  const skuBase = style
    ? buildSkuBase({ division: style.Division, styleNumber: style['Style Number'], colorwayNumber: colorway['Colorway Number'] })
    : null;
  // Have a style but no SKU? The colorway number must be wrong.
  if (style && !skuBase) issues.push(`Colorway Number "${colorway['Colorway Number'] ?? ''}" must be 4 digits (style ${style['Style Number']}, ${style.Division})`);
  // Wrong fabric for the division.
  if (style && style.Fabric && !fabricMatchesDivision(style.Division, style.Fabric)) {
    issues.push(`${style.Division} styles should be ${PRODUCT_MODEL.divisions[style.Division].fabric}, not ${style.Fabric}`);
  }

  // Sample: the pre-production (PP) sample approval is the gate.
  // Only the pre-production samples.
  const pp = samples.filter((s) => s.Round === 'Pre-Production');
  // An approved one, if any.
  const ppApproved = pp.find((s) => s.Status === 'Approved');
  // The most recent one (sorted by decision date, take the last). slice() copies so the original isn't reordered.
  const ppLatest = pp.slice().sort((a, b) => String(a['Decision Date'] || '').localeCompare(String(b['Decision Date'] || ''))).pop();
  // Overall sample status.
  const sampleStatus = ppApproved ? 'Approved' : samples.length ? 'In Progress' : 'Not Started';

  // Compliance: every test the style's profile requires must be Passed (or Not Applicable).
  // The tests this style needs.
  const required = style ? requiredTests(style['Compliance Profile']) : null;
  if (style && !required) issues.push(`Unknown Compliance Profile "${style['Compliance Profile'] ?? ''}"`);
  // Helper: the most recent test of one type (by result date, or submitted date if no result yet).
  const latestOfType = (type) => tests.filter((t) => t['Test Type'] === type)
    .sort((a, b) => String(a['Result Date'] || a['Submitted Date'] || '').localeCompare(String(b['Result Date'] || b['Submitted Date'] || ''))).pop();
  // For each required test type, its latest test (may be missing).
  const perType = (required || []).map((type) => ({ type, test: latestOfType(type) }));
  // Test types whose latest result failed.
  const failed = perType.filter((p) => p.test && p.test.Status === 'Failed').map((p) => p.type);
  // Test types not yet passed (missing, pending or failed).
  const missing = perType.filter((p) => !p.test || !['Passed', 'Not Applicable'].includes(p.test.Status)).map((p) => p.type);
  // Overall compliance status.
  const complianceStatus = !tests.length ? 'Not Started' : failed.length ? 'Failed' : required && !missing.length ? 'Passed' : 'In Testing';

  // Photography: at least one shot, all delivered.
  const photoDone = shots.length > 0 && shots.every((s) => s.Status === 'Delivered');
  const photoStatus = photoDone ? 'Complete' : shots.length ? 'In Progress' : 'Not Started';

  // Licensed prints need an extra licensor approval milestone.
  const licensed = Boolean(print && print.License === 'Licensed');
  // Launch date as "YYYY-MM-DD", or null.
  const launch = colorway['Launch Date'] ? String(colorway['Launch Date']).slice(0, 10) : null;

  // For each milestone: is it done, when, is it blocked, and any extra note.
  const state = {
    // Sample: done when a PP sample is approved; blocked if the latest one was rejected.
    sample: { done: Boolean(ppApproved), completedOn: ppApproved && ppApproved['Decision Date'],
      blocked: !ppApproved && ppLatest && ppLatest.Status === 'Rejected' ? 'Last PP sample rejected: new round needed' : null },
    // License: done when the licensor approves; blocked if they asked for changes.
    license: { done: print && print['Licensor Approval'] === 'Approved', completedOn: print && print['Licensor Approval Date'],
      blocked: print && print['Licensor Approval'] === 'Changes Requested' ? 'Licensor requested changes' : null },
    // Compliance: done when all tests pass (date = last pass); blocked if any failed; note lists what's still waiting.
    compliance: { done: complianceStatus === 'Passed', completedOn: maxDate(tests.filter((t) => t.Status === 'Passed').map((t) => t['Result Date'])),
      blocked: failed.length ? `Failed: ${failed.join(', ')}` : null,
      detail: complianceStatus !== 'Passed' && missing.length && !failed.length ? `Waiting on: ${missing.join(', ')}` : null },
    // Photo: done when all shots are delivered; note shows progress like "2/3 shots delivered".
    photo: { done: photoDone, completedOn: maxDate(shots.map((s) => s['Delivered Date'])),
      detail: !photoDone && shots.length ? `${shots.filter((s) => s.Status === 'Delivered').length}/${shots.length} shots delivered` : null },
    // ERP: done once the colorway has synced to ERPNext.
    erp: { done: colorway['Sync Status'] === 'Synced', completedOn: colorway['Last Synced At'] },
  };

  // Build the milestone list from the product model.
  const milestones = PRODUCT_MODEL.milestones
    // Skip "licensed only" milestones for prints that aren't licensed.
    .filter((m) => !m.licensedOnly || licensed)
    .map((m) => {
      // This milestone's state from above.
      const s = state[m.key];
      // Due date = launch date minus this milestone's lead time (null if no launch date).
      const due = launch ? addDaysIso(launch, -m.daysBeforeLaunch) : null;
      // Only a finished milestone has a completion date (e.g. the last *passed* test is not
      // "compliance passed" while other required tests are still pending).
      const completedOn = s.done && s.completedOn ? String(s.completedOn).slice(0, 10) : null;
      // Work out the status and how many days late.
      let status;
      let daysLate = 0;
      // Done: late if it finished after the due date.
      if (s.done) {
        daysLate = completedOn && due ? Math.max(0, daysBetween(due, completedOn)) : 0;
        status = daysLate > 0 ? 'done_late' : 'done_on_time';
      // Not done and no due date.
      } else if (!due) status = 'open_no_date';
      // Not done, with a due date.
      else {
        // Days until due (negative = already past).
        const daysUntil = daysBetween(today, due);
        if (daysUntil < 0) daysLate = -daysUntil;
        // Blocked beats everything; then late; then "at risk" if due soon; else on track.
        status = s.blocked ? 'blocked' : daysUntil < 0 ? 'open_late' : daysUntil <= PRODUCT_MODEL.atRiskWindowDays ? 'open_at_risk' : 'open_on_track';
      }
      // One row for this milestone.
      return { key: m.key, label: m.label, team: m.team, due, completedOn, status, daysLate, note: s.blocked || s.detail || null };
    });

  // Milestones not yet done.
  const open = milestones.filter((m) => !m.status.startsWith('done'));
  // Data issues (e.g. a malformed colorway number) will block the ERP sync later, so they
  // count as risk even when every date looks fine.
  // Overall timeline status, checked in this order.
  const timeline = !launch ? 'No Launch Date'
    : !open.length ? 'Complete'
    : open.some(isLate) ? 'Late'
    : open.some((m) => m.status === 'open_at_risk' || m.status === 'blocked') || issues.length ? 'At Risk'
    : 'On Track';
  // The next open milestone with the earliest due date (null if none).
  const next = open.filter((m) => m.due).sort((a, b) => a.due.localeCompare(b.due))[0] || null;

  // A symbol for each status, used in the text summary.
  const icon = { done_on_time: '✓', done_late: '✓', open_on_track: '○', open_at_risk: '!', open_late: '✗', blocked: '⛔', open_no_date: '○' };
  // The text summary, one line per data issue then one per milestone.
  const lines = [
    ...issues.map((i) => `⚠ Data: ${i}`),
    ...milestones.map((m) => {
      // Done: e.g. "✓ Sample: done 2026-09-01 (3 days late)".
      if (m.status.startsWith('done')) return `${icon[m.status]} ${m.label}: done ${m.completedOn || '(no date)'}${m.daysLate ? ` (${m.daysLate} days late)` : ''}`;
      // Not done: e.g. "✗ Photo: due 2026-10-01 (<team>), 11 days late · 2/3 shots delivered".
      const when = m.due ? `due ${m.due}` : 'no launch date';
      const lateness = m.status === 'open_late' || (m.status === 'blocked' && m.daysLate) ? `, ${m.daysLate} days late` : m.status === 'open_at_risk' ? ', at risk' : '';
      return `${icon[m.status]} ${m.label}: ${when} (${m.team})${lateness}${m.note ? ` · ${m.note}` : ''}`;
    }),
  ];

  return {
    issues,
    milestones,
    // The Airtable Colorway fields to write back.
    fields: {
      'SKU Base': skuBase || '',
      'Sample Status': sampleStatus,
      'Compliance Status': complianceStatus,
      'Photo Status': photoStatus,
      'Timeline Status': timeline,
      'Next Milestone': next ? `${next.label} (${next.team}), due ${next.due}` : '',
      'Next Due Date': next ? next.due : null,
      // The most days late of any open milestone (0 if none).
      'Days Late': Math.max(0, ...open.map((m) => m.daysLate)),
      'Critical Path': lines.join('\n'),
    },
  };
}

// Only send fields whose value changed: saves Airtable API calls and keeps the record's
// revision history meaningful. Airtable omits empty fields, so treat ''/null/undefined alike.
function diffFields(current, computed) {
  // Helper: treat undefined, null and '' all as null.
  const norm = (v) => (v === undefined || v === null || v === '' ? null : v);
  // The fields that differ.
  const changed = {};
  // Compare each computed field with what's in Airtable now.
  for (const [k, v] of Object.entries(computed)) {
    if (norm(current[k]) !== norm(v)) changed[k] = v;
  }
  // Return the changes, or null if nothing changed.
  return Object.keys(changed).length ? changed : null;
}

// One Slack message for the whole portfolio, grouped by owning team (alert per cause, not
// one ping per colorway). Returns null when nothing is late or at risk.
function buildTeamDigest(results, { maxPerTeam = 8 } = {}) {
  // team name → list of problem milestones.
  const byTeam = new Map();
  // Data problems across all colorways.
  const dataIssues = [];
  // Go through each colorway's results.
  for (const r of results) {
    for (const m of r.milestones) {
      // Only late, blocked or at-risk milestones go in the digest.
      if (!['open_late', 'blocked', 'open_at_risk'].includes(m.status)) continue;
      // First one for this team? Start its list.
      if (!byTeam.has(m.team)) byTeam.set(m.team, []);
      // Add the milestone, tagged with its colorway.
      byTeam.get(m.team).push({ ...m, colorway: r.colorwayName, skuBase: r.skuBase });
    }
    // Collect this colorway's data issues.
    for (const issue of r.issues || []) dataIssues.push(`  ⚠ ${r.colorwayName}: ${issue}`);
  }
  // Nothing to report? No message.
  if (!byTeam.size && !dataIssues.length) return null;
  // One section per team, teams in A–Z order.
  const sections = [...byTeam.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([team, items]) => {
    // Most days late first; ties broken by earliest due date.
    items.sort((a, b) => b.daysLate - a.daysLate || String(a.due).localeCompare(String(b.due)));
    // How many are actually late (the rest are at risk).
    const late = items.filter(isLate).length;
    // Section heading, e.g. "*<team>*: 2 late, 1 at risk".
    const head = `*${team}*: ${late} late, ${items.length - late} at risk`;
    // One line per milestone, up to maxPerTeam (8).
    const rows = items.slice(0, maxPerTeam).map((i) =>
      `  ${i.status === 'blocked' ? '⛔' : isLate(i) ? '✗' : '!'} ${i.colorway}${i.skuBase ? ` (${i.skuBase})` : ''}: ${i.label}, due ${i.due}${i.daysLate ? `, ${i.daysLate} days late` : ''}${i.note ? ` · ${i.note}` : ''}`);
    // Too many to list? Say how many were left out.
    if (items.length > maxPerTeam) rows.push(`  …and ${items.length - maxPerTeam} more`);
    return [head, ...rows].join('\n');
  });
  // Add a data issues section at the end, if there are any.
  if (dataIssues.length) sections.push([`*Data issues* (fix in Airtable): ${dataIssues.length}`, ...dataIssues.slice(0, maxPerTeam)].join('\n'));
  // Put it all together under one title.
  return [':calendar: *Launch critical path*: milestones late or due within a week', ...sections].join('\n');
}

// Split a list into smaller lists of "size" items each, e.g. chunk([1,2,3], 2) → [[1,2],[3]].
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
