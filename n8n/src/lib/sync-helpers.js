// ---- lib/sync-helpers.js ------------------------------------------------
// Error parsing, audit rows, Airtable write-backs and PO explosion shared by
// the n8n Code nodes. Pure functions only — no n8n globals in here.

// Frappe/ERPNext maps exceptions to HTTP codes; knowing them speeds up triage.
// Lookup table: HTTP status code → a short, readable error category.
const ERP_ERROR_CATEGORIES = {
  401: 'auth',            // AuthenticationError — bad/expired API key:secret
  403: 'permission',      // PermissionError — role lacks perm on the DocType
  404: 'not_found',       // DoesNotExistError
  409: 'duplicate',       // DuplicateEntryError — item_code already exists
  417: 'validation',      // ValidationError / LinkValidationError / MandatoryError
  429: 'rate_limited',
};

// Pulls a JSON object out of an error string. n8n 2.x formats HTTP errors as
//   417 - "{\"exc_type\":\"LinkValidationError\",...}"
// i.e. the response body as a JSON *string literal*, so it may need two parses.
function extractJsonBody(part) {
  // Already an object? Nothing to do, return it.
  if (part && typeof part === 'object') return part;
  // Make it text, strip a leading "417 - " style status code, and trim spaces.
  const s = String(part || '').replace(/^\s*\d{3} - /, '').trim();
  // Two things to try: the whole text, and just the part from the first "{" to the last "}".
  const attempts = [s, s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)];
  // Try each one in turn.
  for (const candidate of attempts) {
    try {
      // Read the text as JSON.
      let v = JSON.parse(candidate);
      // If that gave us more text (JSON inside a string), read it as JSON again.
      if (typeof v === 'string') v = JSON.parse(v);
      // Got a real object? Return it.
      if (v && typeof v === 'object') return v;
    } catch { /* try the next shape */ }
  }
  // Nothing worked: no JSON found.
  return null;
}

// Normalizes an n8n error-output item ({ error: {...} }) from an HTTP Request node.
// Shape verified against n8n 2.39.6 (see tests); kept defensive for other versions.
function summarizeHttpError(itemJson) {
  // The error details: inside "error" if present, else the item itself, else an empty object.
  const e = (itemJson && itemJson.error) || itemJson || {};
  // Gather every bit of error text we can find into one string, separated by " | ".
  const text = [e.message, typeof e.description === 'string' ? e.description : '', typeof e === 'string' ? e : '']
    // Drop the empty bits.
    .filter(Boolean)
    // Make sure each bit is text.
    .map(String)
    // Join them.
    .join(' | ');

  // Look for the HTTP status code in the usual fields (null if none found).
  let httpStatus = Number(e.httpCode || e.statusCode || e.status) || null;
  // Not found? Try to read it from the error text instead.
  if (!httpStatus) {
    // Only trust the shapes n8n/axios actually emit ("409 - ...", "status code 502"),
    // so digits inside IPs or ports (ECONNREFUSED 172.18.0.5:8080) aren't misread.
    const m = text.match(/^([1-5]\d{2}) - /) || text.match(/status code ([1-5]\d{2})\b/i);
    // Found a match? Use the 3-digit number. Otherwise still null.
    httpStatus = m ? Number(m[1]) : null;
  }

  // Pull exc_type / _server_messages (ERPNext) or error.message (Airtable) out of the body.
  // The error type name, e.g. "LinkValidationError".
  let excType = null;
  // The human-readable message from the server.
  let serverMessage = null;
  // Look for a JSON body in the message, or failing that in the description.
  const body = extractJsonBody(e.message) || extractJsonBody(e.description);
  // Only dig further if we found one.
  if (body) {
    // ERPNext puts the type in exc_type; Airtable puts it in error.type.
    excType = body.exc_type || (body.error && body.error.type) || null;
    // ERPNext style 1: a list of messages, itself stored as JSON text.
    if (body._server_messages) {
      try {
        // Read the list, then read each message (also JSON) and keep its "message" part.
        serverMessage = JSON.parse(body._server_messages)
          .map((m) => { try { return JSON.parse(m).message; } catch { return m; } })
          // Join them with "; ".
          .join('; ');
      } catch { /* malformed — ignore */ }
    // ERPNext style 2: a Python traceback. The last line holds the actual error.
    } else if (body.exception) {
      serverMessage = String(body.exception).split('\n').pop();
    // Airtable style: error.message.
    } else if (body.error && body.error.message) {
      serverMessage = body.error.message;
    }
    // Remove any HTML tags (like <b>) from the message.
    if (serverMessage) serverMessage = serverMessage.replace(/<[^>]+>/g, '');
  }

  // Pick a category: from the table above, else "server" for 5xx codes,
  // "client" for other codes, or "network" if there was no code at all.
  const category = ERP_ERROR_CATEGORIES[httpStatus] || (httpStatus >= 500 ? 'server' : httpStatus ? 'client' : 'network');
  // These kinds of error usually fix themselves, so it's worth trying again later.
  const retryable = category === 'server' || category === 'rate_limited' || category === 'network';
  // Plain-text bodies arrive JSON-quoted (sometimes twice): 502 - "\"Bad Gateway\"".
  // Backup message: the raw error text without the leading status code.
  let fallback = String(e.message || text || 'Unknown error').replace(/^\s*\d{3} - /, '');
  // Remove up to two layers of JSON quotes.
  for (let i = 0; i < 2; i++) {
    try {
      // Read it as JSON.
      const v = JSON.parse(fallback);
      // Not plain text underneath? Stop and keep what we have.
      if (typeof v !== 'string') break;
      // Keep the unquoted text.
      fallback = v;
    } catch { break; }
  }
  // Final message, e.g. "HTTP 417 — LinkValidationError — Item Group X not found".
  const message = [httpStatus && `HTTP ${httpStatus}`, excType, serverMessage || fallback]
    // Drop empty parts.
    .filter(Boolean)
    // Join with " — ".
    .join(' — ')
    // Cut to 1000 characters.
    .slice(0, 1000);

  // Hand back the summary.
  return { httpStatus, category, retryable, excType, message };
}

// One row for audit.sync_audit_logs. Column order matches the INSERT in the Postgres nodes.
// Takes friendly names (f.entityId) and returns database column names (entity_id).
// "|| null" means: use null when the value is missing.
function auditRow(f) {
  return {
    // The n8n run ID as text.
    execution_id: f.executionId != null ? String(f.executionId) : null,
    workflow_name: f.workflowName || null,
    // Where the data came from and where it was going.
    source_system: f.source,
    target_system: f.target,
    // What kind of thing (e.g. sales_order) and which one.
    entity_type: f.entityType,
    entity_id: f.entityId || null,
    sku: f.sku || null,
    // What we tried and how it went.
    action: f.action,
    status: f.status,
    // "??" keeps 0 but turns missing into null.
    http_status: f.httpStatus ?? null,
    // Error text cut to 1000 characters, or null if there was no error.
    error_message: f.errorMessage ? String(f.errorMessage).slice(0, 1000) : null,
    approved_at: f.approvedAt || null,
    // Extra details (empty object if none).
    payload: f.payload || {},
  };
}

// PATCH body for writing sync results back onto the Airtable Colorways record.
// Transient failures go back to "Pending" so the safety-net poll retries them;
// permanent ones go to "Error" for a human. (n8n ignores Retry On Fail on nodes that
// use an error output, so this is the retry mechanism for ERP calls. See RUNBOOK §3.)
function syncWriteback({ status, erpItemCode, errorMessage, nowIso, retryable = false }) {
  // Did the sync work?
  const ok = status === 'success';
  return {
    fields: {
      // Worked → "Synced". Temporary failure → "Pending" (retry). Permanent failure → "Error".
      'Sync Status': ok ? 'Synced' : retryable ? 'Pending' : 'Error',
      // Only on success: also save the ERP item code.
      ...(ok && erpItemCode ? { 'ERP Item Code': erpItemCode } : {}),
      // Clear the error on success; otherwise save it (cut to 5000 characters).
      'Last Sync Error': ok ? '' : String(errorMessage || '').slice(0, 5000),
      // When this happened.
      'Last Synced At': nowIso,
    },
    // Let Airtable convert values to the right field type.
    typecast: true,
  };
}

// Airtable formula: {Field}='value' with quotes/backslashes escaped.
function airtableEquals(field, value) {
  // Make the value text, then put a "\" before any "\" or "'" so they can't break the formula.
  const escaped = String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  // Build the formula, e.g. {ERP Item Code}='S-0108-0901'.
  return `{${field}}='${escaped}'`;
}

// ERPNext Purchase Order doc → one row per COLORWAY (POs are placed per size variant,
// S-0108-0901-10, but Production tracks the colorway S-0108-0901): summed qty, earliest
// schedule date and a per-size breakdown. Needs lib/product-model.js for parseSku.
function explodePurchaseOrder(po) {
  // Running totals: colorway SKU → { qty, date, sizes }.
  const byColorway = new Map();
  // Go through each line on the PO.
  for (const line of po.items || []) {
    // Split the SKU into its parts (division, style, colorway, size).
    const parsed = parseSku(line.item_code);
    // The colorway SKU (without the size), or the raw code if it couldn't be parsed.
    const base = parsed ? `${parsed.divisionCode}-${parsed.style}-${parsed.colorway}` : line.item_code;
    // The size label (e.g. "Preemie"), or null if the SKU has no size.
    const size = parsed && parsed.sizeCode ? sizeLabelFor(parsed.divisionCode, parsed.sizeCode) : null;
    // Quantity as a number (0 if missing).
    const qty = Number(line.qty) || 0;
    // Delivery date: the line's own date, else the PO's date, else none.
    const date = line.schedule_date || po.schedule_date || null;
    // First line for this colorway? Start its running totals at zero.
    if (!byColorway.has(base)) byColorway.set(base, { qty: 0, date: null, sizes: [] });
    // Get the running totals for this colorway.
    const agg = byColorway.get(base);
    // Add this line's quantity.
    agg.qty += qty;
    // Keep the earliest date seen.
    if (date && (!agg.date || date < agg.date)) agg.date = date;
    // Note the size and quantity, e.g. "Preemie ×12".
    if (size) agg.sizes.push(`${size} ×${qty}`);
  }
  // Turn the totals into one output row per colorway.
  return [...byColorway.entries()].map(([base, agg]) => ({
    po_number: po.name,
    supplier: po.supplier,
    // The PO status, or work it out: docstatus 1 means submitted, otherwise draft.
    po_status: po.status || (po.docstatus === 1 ? 'Submitted' : 'Draft'),
    item_code: base,
    qty: agg.qty,
    expected_delivery: agg.date,
    // Formula used to find the matching Airtable record.
    airtable_formula: airtableEquals('ERP Item Code', base),
    // The fields to write onto that Airtable record.
    airtable_fields: {
      'PO Number': po.name,
      'PO Qty': agg.qty,
      // e.g. "Preemie ×12, Newborn ×24" (null if no sizes).
      'PO Size Breakdown': agg.sizes.join(', ') || null,
      Vendor: po.supplier,
      'Expected Delivery': agg.date,
      'PO Status': po.status || null,
    },
  }));
}
