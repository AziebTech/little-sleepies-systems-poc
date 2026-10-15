// Builds importable n8n workflow JSON from source.
//
//   node n8n/build-workflows.mjs
//
// Why generate instead of hand-exporting from the UI?
//  - Code-node logic lives in n8n/src as plain JS that is unit-tested (tests/js).
//  - Workflow diffs in git are readable and reviewable.
//  - Credential and workflow IDs are fixed, so the error-workflow link and
//    credential references survive a fresh import.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'workflows');

// ---------------------------------------------------------------- ids & credentials
const WF_IDS = {
  errorHandler: 'lsWf00ErrorHndlr',
  skuProvision: 'lsWf01SkuProvisn',
  poDelivery: 'lsWf02PoDelivery',
  freshness: 'lsWf03Freshness0',
  shopifyProduct: 'lsWf04ShopifyPrd',
  shopifyOrders: 'lsWf05ShopifyOrd',
  criticalPath: 'lsWf06CritclPath',
};

export const CREDENTIALS = {
  erp: { type: 'httpHeaderAuth', id: 'lsErpnextApiCred', name: 'ERPNext API (integration user)' },
  airtable: { type: 'httpHeaderAuth', id: 'lsAirtablePatCrd', name: 'Airtable PAT' },
  warehouse: { type: 'postgres', id: 'lsWarehousePgCrd', name: 'LS Warehouse (Postgres)' },
  webhook: { type: 'httpHeaderAuth', id: 'lsWebhookTokenCr', name: 'LS Inbound Webhook Token' },
};
const credRef = (c) => ({ [c.type]: { id: c.id, name: c.name } });

const uuid = (seed) => {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// ---------------------------------------------------------------- code loading
// Directives (one per line, recursive):
//   // @include lib/x.js                      → inline a source file from n8n/src
//   // @include-json shared/x.json NAME       → `const NAME = {...};` from a repo-root JSON file
export function expandIncludes(src) {
  return src
    .replace(/^\/\/ @include-json (\S+) (\w+)\s*$/gm, (_, path, name) =>
      `const ${name} = ${JSON.stringify(JSON.parse(readFileSync(join(ROOT, '..', path), 'utf8')))};`)
    .replace(/^\/\/ @include (\S+)\s*$/gm, (_, inc) => expandIncludes(readFileSync(join(SRC, inc), 'utf8')).trimEnd());
}

export function loadCode(file) {
  return expandIncludes(readFileSync(join(SRC, 'code', file), 'utf8'));
}

// ---------------------------------------------------------------- node factories
const AT_BASE = 'https://api.airtable.com/v0/{{ $env.AIRTABLE_BASE_ID }}';
const AT_TABLE = `${AT_BASE}/Colorways`; // product model v2 (airtable/SCHEMA.md)
const ERP = '{{ $env.ERPNEXT_BASE_URL }}/api/resource';
const AIRTABLE_BATCHING = { batch: { batchSize: 5, batchInterval: 1100 } }; // Airtable: 5 req/s per base

function base(wfKey, name, type, typeVersion, position, parameters, extra = {}) {
  return { parameters, id: uuid(`${wfKey}:${name}`), name, type, typeVersion, position, ...extra };
}

const nodes = (wfKey) => ({
  note: (name, position, content, width = 420, height = 300) =>
    base(wfKey, name, 'n8n-nodes-base.stickyNote', 1, position, { content, width, height }),

  webhook: (name, position, path) =>
    base(wfKey, name, 'n8n-nodes-base.webhook', 2, position,
      { httpMethod: 'POST', path, authentication: 'headerAuth', options: {} },
      { webhookId: uuid(`webhook:${path}`), credentials: credRef(CREDENTIALS.webhook) }),

  // Shopify authenticates by signing the body (HMAC), not with a header token, so the
  // node keeps the raw bytes for verification in a Code node.
  rawWebhook: (name, position, path) =>
    base(wfKey, name, 'n8n-nodes-base.webhook', 2, position,
      { httpMethod: 'POST', path, options: { rawBody: true } },
      { webhookId: uuid(`webhook:${path}`) }),

  schedule: (name, position, interval) =>
    base(wfKey, name, 'n8n-nodes-base.scheduleTrigger', 1.2, position, { rule: { interval: [interval] } }),

  errorTrigger: (name, position) => base(wfKey, name, 'n8n-nodes-base.errorTrigger', 1, position, {}),

  code: (name, position, file, mode = 'runOnceForEachItem') =>
    base(wfKey, name, 'n8n-nodes-base.code', 2, position,
      mode === 'runOnceForEachItem' ? { mode, jsCode: loadCode(file) } : { jsCode: loadCode(file) }),

  // n8n does not apply Retry On Fail when a node routes errors to an error output
  // (verified on n8n 2.39.6), so retries are only configured where they take effect.
  http: (name, position, { method = 'GET', url, cred, query, headers, body, form, batching, airtablePages = false,
    executeOnce = false, errorOutput = false, retry = !errorOutput }) => {
    const parameters = { method, url };
    if (cred) Object.assign(parameters, { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' });
    if (query) Object.assign(parameters, { sendQuery: true, queryParameters: { parameters: query } });
    if (headers) Object.assign(parameters, { sendHeaders: true, headerParameters: { parameters: headers } });
    if (body) Object.assign(parameters, { sendBody: true, specifyBody: 'json', jsonBody: body });
    if (form) Object.assign(parameters, { sendBody: true, contentType: 'form-urlencoded', bodyParameters: { parameters: form } });
    parameters.options = {
      ...(batching ? { batching } : {}),
      // Follow Airtable's `offset` cursor until it disappears (100 records per page).
      ...(airtablePages ? { pagination: { pagination: {
        paginationMode: 'updateAParameterInEachRequest',
        parameters: { parameters: [{ type: 'qs', name: 'offset', value: '={{ $response.body.offset }}' }] },
        paginationCompleteWhen: 'other',
        completeExpression: '={{ !$response.body.offset }}',
        limitPagesFetched: true, maxRequests: 50, requestInterval: 250,
      } } } : {}),
    };
    const extra = {};
    // Run once even if the previous node emitted several items (e.g. several result pages).
    if (executeOnce) extra.executeOnce = true;
    if (cred) extra.credentials = credRef(cred);
    if (retry) Object.assign(extra, { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 });
    if (errorOutput) extra.onError = 'continueErrorOutput';
    return base(wfKey, name, 'n8n-nodes-base.httpRequest', 4.2, position, parameters, extra);
  },

  ifNode: (name, position, leftValue, operator, rightValue = '') =>
    base(wfKey, name, 'n8n-nodes-base.if', 2, position, {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{ id: uuid(`${wfKey}:${name}:cond`), leftValue, rightValue, operator }],
        combinator: 'and',
      },
      options: {},
    }),

  postgres: (name, position, query, replacement, extra = {}) =>
    base(wfKey, name, 'n8n-nodes-base.postgres', 2.5, position,
      { operation: 'executeQuery', query, options: replacement ? { queryReplacement: replacement } : {} },
      { credentials: credRef(CREDENTIALS.warehouse), ...extra }),
});

const OP = {
  isTrue: { type: 'boolean', operation: 'true', singleValue: true },
  notEmpty: { type: 'string', operation: 'notEmpty', singleValue: true },
  equals: { type: 'string', operation: 'equals' },
};

function connect(list) {
  // list: [from, to, outputIndex?]
  const c = {};
  for (const [from, to, out = 0] of list) {
    c[from] ??= { main: [] };
    while (c[from].main.length <= out) c[from].main.push([]);
    c[from].main[out].push({ node: to, type: 'main', index: 0 });
  }
  return c;
}

function workflow(key, name, nodeList, links, settings = {}) {
  return {
    id: WF_IDS[key],
    name,
    active: false,
    nodes: nodeList,
    connections: connect(links),
    settings: { executionOrder: 'v1', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all', ...settings },
    pinData: {},
    meta: { templateCredsSetupCompleted: true },
  };
}

const AUDIT_SQL = `INSERT INTO audit.sync_audit_logs
  (execution_id, workflow_name, source_system, target_system, entity_type, entity_id,
   sku, action, status, http_status, error_message, approved_at, payload)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::int, $11, $12::timestamptz, $13::jsonb);`;
const AUDIT_PARAMS = '={{ [$json.execution_id, $json.workflow_name, $json.source_system, $json.target_system, $json.entity_type, $json.entity_id, $json.sku, $json.action, $json.status, $json.http_status, $json.error_message, $json.approved_at, JSON.stringify($json.payload || {})] }}';

// ================================================================ LS-00 Error handler
function errorHandler() {
  const n = nodes('wf00');
  return workflow('errorHandler', 'LS-00 Global Error Handler', [
    n.note('About', [-460, -160],
      '## LS-00 Global Error Handler\nSet as the **Error Workflow** on every LS workflow (Workflow Settings).\n\nRuns when an execution *crashes* (unhandled error, or a node without an error output fails after retries).\n\n1. Logs to `audit.workflow_errors`\n2. Posts to Slack if `SLACK_WEBHOOK_URL` is set\n\nRunbook: docs/RUNBOOK.md §5'),
    n.errorTrigger('Error Trigger', [0, 0]),
    n.code('Format Alert', [220, 0], 'format-error-alert.js'),
    n.postgres('Log Workflow Error', [460, -100],
      'INSERT INTO audit.workflow_errors (execution_id, workflow_id, workflow_name, last_node, error_message, execution_url) VALUES ($1, $2, $3, $4, $5, $6);',
      '={{ [$json.execution_id, $json.workflow_id, $json.workflow_name, $json.last_node, $json.error_message, $json.execution_url] }}'),
    n.ifNode('Slack Configured?', [460, 100], '={{ $env.SLACK_WEBHOOK_URL }}', OP.notEmpty),
    n.http('Post to Slack', [700, 80], { method: 'POST', url: '={{ $env.SLACK_WEBHOOK_URL }}', body: '={{ JSON.stringify({ text: $json.slack_text }) }}' }),
  ], [
    ['Error Trigger', 'Format Alert'],
    ['Format Alert', 'Log Workflow Error'],
    ['Format Alert', 'Slack Configured?'],
    ['Slack Configured?', 'Post to Slack', 0],
  ]);
}

// ================================================================ LS-01 Airtable -> ERPNext SKU provisioning
function skuProvision() {
  const n = nodes('wf01');
  const VALIDATE = 'Validate & Build ERP Payload';
  const lookup = (name, tableName, position) => n.http(name, position, {
    cred: CREDENTIALS.airtable, url: `=${AT_BASE}/${encodeURIComponent(tableName)}`, airtablePages: true, executeOnce: true,
    query: [{ name: 'pageSize', value: '100' }],
  });
  return workflow('skuProvision', 'LS-01 Airtable Colorway → ERPNext: Style Template + Size Variants', [
    n.note('About', [-560, -460],
      '## LS-01 Colorway → ERPNext template + size variants\n**Ready for ERP** = Production Status *Approved for Production* AND Compliance Status *Passed* (computed by LS-06).\n**Trigger A:** Airtable automation POSTs `{ recordId }`. **Trigger B:** 6-hourly sweep of ready, unsynced colorways.\n\n1. Style Master, Prints, Size Codes loaded **once per run** and joined in code\n2. Template `S-0108-0901` (NetSuite: matrix parent) upserted by `custom_airtable_record_id`\n3. ONE call asks ERPNext to create the size variants `S-0108-0901-10`… (skips sizes that exist; large size runs are queued to a worker)\n\nTransient ERP errors → *Pending* (auto-retry). Permanent → *Error*.',
      560, 360),
    n.webhook('Airtable Webhook', [0, 0], 'airtable-approved'),
    n.http('Fetch Airtable Colorway', [220, 0], { cred: CREDENTIALS.airtable, url: `=${AT_TABLE}/{{ $json.body.recordId }}` }),
    n.schedule('Safety-Net Poll (6h)', [0, 220], { field: 'hours', hoursInterval: 6 }),
    n.http('List Ready & Unsynced', [220, 220], {
      cred: CREDENTIALS.airtable, url: `=${AT_TABLE}`, airtablePages: true,
      query: [
        { name: 'filterByFormula', value: "AND({Production Status}='Approved for Production', {Compliance Status}='Passed', OR({Sync Status}='', {Sync Status}='Not Synced', {Sync Status}='Pending'))" },
        { name: 'pageSize', value: '100' },
      ],
    }),
    n.code('Normalize Records', [440, 100], 'normalize-records.js', 'runOnceForAllItems'),
    lookup('Load Style Master', 'Style Master', [660, 100]),
    lookup('Load Prints', 'Prints', [880, 100]),
    lookup('Load Size Codes', 'Size Codes', [1100, 100]),
    n.code(VALIDATE, [1320, 100], 'validate-transform.js', 'runOnceForAllItems'),
    n.ifNode('Valid?', [1540, 100], '={{ $json.valid }}', OP.isTrue),
    n.http('Find Existing ERP Template', [1760, 0], {
      cred: CREDENTIALS.erp, url: `=${ERP}/Item`, errorOutput: true,
      query: [
        { name: 'filters', value: '={{ JSON.stringify([["custom_airtable_record_id", "=", $json.recordId], ["has_variants", "=", 1]]) }}' },
        { name: 'fields', value: '["name"]' },
      ],
    }),
    n.ifNode('Already in ERP?', [1980, -40], '={{ ($json.data || []).length > 0 }}', OP.isTrue),
    n.http('Update ERP Template', [2200, -160], {
      method: 'PUT', cred: CREDENTIALS.erp, errorOutput: true,
      url: `=${ERP}/Item/{{ encodeURIComponent($json.data[0].name) }}`,
      body: `={{ JSON.stringify($('${VALIDATE}').item.json.updatePayload) }}`,
    }),
    n.http('Create ERP Template', [2200, 20], {
      method: 'POST', cred: CREDENTIALS.erp, errorOutput: true,
      url: `=${ERP}/Item`,
      body: `={{ JSON.stringify($('${VALIDATE}').item.json.templatePayload) }}`,
    }),
    n.http('Create Size Variants', [2420, -60], {
      method: 'POST', cred: CREDENTIALS.erp, errorOutput: true,
      url: '={{ $env.ERPNEXT_BASE_URL }}/api/method/erpnext.controllers.item_variant.enqueue_multiple_variant_creation',
      body: `={{ JSON.stringify($('${VALIDATE}').item.json.variantRequest) }}`,
    }),
    n.code('Result: Synced', [2660, -160], 'result-synced.js'),
    n.code('Result: ERP Error', [2660, 120], 'result-erp-error.js'),
    n.code('Result: Validation Failed', [2660, 340], 'result-validation-failed.js'),
    n.http('Write Back to Airtable', [2900, 0], {
      method: 'PATCH', cred: CREDENTIALS.airtable,
      url: `=${AT_TABLE}/{{ $json.airtable_record_id }}`,
      body: '={{ JSON.stringify($json.airtable_patch) }}',
      batching: AIRTABLE_BATCHING,
    }),
    n.postgres('Write Audit Log', [2900, 260], AUDIT_SQL, AUDIT_PARAMS),
  ], [
    ['Airtable Webhook', 'Fetch Airtable Colorway'],
    ['Fetch Airtable Colorway', 'Normalize Records'],
    ['Safety-Net Poll (6h)', 'List Ready & Unsynced'],
    ['List Ready & Unsynced', 'Normalize Records'],
    ['Normalize Records', 'Load Style Master'],
    ['Load Style Master', 'Load Prints'],
    ['Load Prints', 'Load Size Codes'],
    ['Load Size Codes', VALIDATE],
    [VALIDATE, 'Valid?'],
    ['Valid?', 'Find Existing ERP Template', 0],
    ['Valid?', 'Result: Validation Failed', 1],
    ['Find Existing ERP Template', 'Already in ERP?', 0],
    ['Find Existing ERP Template', 'Result: ERP Error', 1],
    ['Already in ERP?', 'Update ERP Template', 0],
    ['Already in ERP?', 'Create ERP Template', 1],
    ['Update ERP Template', 'Create Size Variants', 0],
    ['Update ERP Template', 'Result: ERP Error', 1],
    ['Create ERP Template', 'Create Size Variants', 0],
    ['Create ERP Template', 'Result: ERP Error', 1],
    ['Create Size Variants', 'Result: Synced', 0],
    ['Create Size Variants', 'Result: ERP Error', 1],
    ...['Result: Synced', 'Result: ERP Error', 'Result: Validation Failed'].flatMap((r) => [
      [r, 'Write Back to Airtable'],
      [r, 'Write Audit Log'],
    ]),
  ], { errorWorkflow: WF_IDS.errorHandler });
}

// ================================================================ LS-02 ERPNext PO -> Airtable
function poDelivery() {
  const n = nodes('wf02');
  return workflow('poDelivery', 'LS-02 ERPNext PO → Airtable: Delivery Updates', [
    n.note('About', [-520, -400],
      '## LS-02 ERPNext Purchase Order → Airtable\n**Trigger A:** ERPNext Webhook on Purchase Order *on_submit* / *on_update_after_submit* POSTs `{ name }`.\n**Trigger B:** hourly poll of POs modified in the last 75 min (ERPNext-only API cost).\n\nRe-fetches the full PO and rolls size-variant lines (`S-0108-0901-10`) up to their **colorway** (`S-0108-0901`), then writes PO #, total qty, per-size breakdown, vendor and expected delivery onto the Airtable Colorway (matched by **ERP Item Code**).\n\nLines for items with no colorway (e.g. legacy items) are logged as `skipped`, not errors.',
      520, 300),
    n.webhook('ERPNext PO Webhook', [0, 0], 'erpnext-po'),
    n.schedule('Hourly Poll', [0, 220], { field: 'hours', hoursInterval: 1 }),
    n.http('List Recently Modified POs', [220, 220], {
      cred: CREDENTIALS.erp, url: `=${ERP}/Purchase Order`,
      query: [
        { name: 'filters', value: "={{ JSON.stringify([[\"docstatus\", \"=\", 1], [\"modified\", \">\", $now.minus({ minutes: 75 }).toFormat('yyyy-MM-dd HH:mm:ss')]]) }}" },
        { name: 'fields', value: '["name"]' },
        { name: 'limit_page_length', value: '500' },
      ],
    }),
    n.code('Collect PO Names', [440, 100], 'collect-po-names.js', 'runOnceForAllItems'),
    n.http('Get PO Detail', [660, 100], {
      cred: CREDENTIALS.erp, errorOutput: true,
      url: `=${ERP}/Purchase Order/{{ encodeURIComponent($json.po_name) }}`,
    }),
    n.code('Explode PO Lines', [880, 0], 'explode-po-lines.js', 'runOnceForAllItems'),
    n.http('Find Airtable Colorway', [1100, 0], {
      cred: CREDENTIALS.airtable, url: `=${AT_TABLE}`, errorOutput: true, batching: AIRTABLE_BATCHING,
      query: [
        { name: 'filterByFormula', value: '={{ $json.airtable_formula }}' },
        { name: 'maxRecords', value: '1' },
      ],
    }),
    n.ifNode('Colorway Found?', [1320, -60], '={{ ($json.records || []).length > 0 }}', OP.isTrue),
    n.http('Update Colorway Delivery Info', [1540, -160], {
      method: 'PATCH', cred: CREDENTIALS.airtable, errorOutput: true, batching: AIRTABLE_BATCHING,
      url: `=${AT_TABLE}/{{ $json.records[0].id }}`,
      body: "={{ JSON.stringify({ fields: $('Explode PO Lines').item.json.airtable_fields, typecast: true }) }}",
    }),
    n.code('Result: PO Synced', [1780, -160], 'result-po-synced.js'),
    n.code('Result: No Matching Colorway', [1780, 20], 'result-po-unmatched.js'),
    n.code('Result: PO Line Error', [1780, 200], 'result-po-line-error.js'),
    n.code('Result: PO Fetch Error', [1780, 380], 'result-po-fetch-error.js'),
    n.postgres('Write Audit Log', [2020, 100], AUDIT_SQL, AUDIT_PARAMS),
  ], [
    ['ERPNext PO Webhook', 'Collect PO Names'],
    ['Hourly Poll', 'List Recently Modified POs'],
    ['List Recently Modified POs', 'Collect PO Names'],
    ['Collect PO Names', 'Get PO Detail'],
    ['Get PO Detail', 'Explode PO Lines', 0],
    ['Get PO Detail', 'Result: PO Fetch Error', 1],
    ['Explode PO Lines', 'Find Airtable Colorway'],
    ['Find Airtable Colorway', 'Colorway Found?', 0],
    ['Find Airtable Colorway', 'Result: PO Line Error', 1],
    ['Colorway Found?', 'Update Colorway Delivery Info', 0],
    ['Colorway Found?', 'Result: No Matching Colorway', 1],
    ['Update Colorway Delivery Info', 'Result: PO Synced', 0],
    ['Update Colorway Delivery Info', 'Result: PO Line Error', 1],
    ...['Result: PO Synced', 'Result: No Matching Colorway', 'Result: PO Line Error', 'Result: PO Fetch Error']
      .map((r) => [r, 'Write Audit Log']),
  ], { errorWorkflow: WF_IDS.errorHandler });
}

// ================================================================ LS-03 Pipeline freshness monitor
function freshness() {
  const n = nodes('wf03');
  return workflow('freshness', 'LS-03 Sync Pipeline Health Check', [
    n.note('About', [-480, -200],
      '## LS-03 Pipeline health check\nHourly: how long since the last successful sync, and what is the 24h error rate?\n\nEvery run is recorded in `audit.pipeline_health_checks` (trend history). Breaches alert Slack.\n\nSnowflake equivalent: a Task + ACCOUNT_USAGE.TASK_HISTORY / COPY_HISTORY checks (see sql/snowflake).',
      440, 260),
    n.schedule('Hourly', [0, 0], { field: 'hours', hoursInterval: 1 }),
    n.postgres('Query Pipeline Health', [220, 0], `SELECT
  EXTRACT(EPOCH FROM (now() - MAX(created_at) FILTER (WHERE status = 'success'))) / 3600.0 AS hours_since_last_success,
  COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS events_24h,
  COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours' AND status = 'failed') AS failures_24h
FROM audit.sync_audit_logs
WHERE workflow_name IS DISTINCT FROM 'demo-seed';`),
    n.code('Evaluate Thresholds', [440, 0], 'evaluate-freshness.js'),
    n.postgres('Record Health Check', [680, -120],
      'INSERT INTO audit.pipeline_health_checks (hours_since_last_success, events_24h, failures_24h, error_rate_24h, status, breaches) VALUES ($1::numeric, $2::int, $3::int, $4::numeric, $5, $6::jsonb);',
      '={{ [$json.hours_since_last_success, $json.events_24h, $json.failures_24h, $json.error_rate_24h, $json.status, JSON.stringify($json.breaches)] }}'),
    n.ifNode('Breach?', [680, 80], '={{ $json.status }}', OP.equals, 'breach'),
    n.ifNode('Slack Configured?', [900, 60], '={{ $env.SLACK_WEBHOOK_URL }}', OP.notEmpty),
    n.http('Post to Slack', [1120, 40], { method: 'POST', url: '={{ $env.SLACK_WEBHOOK_URL }}', body: '={{ JSON.stringify({ text: $json.slack_text }) }}' }),
  ], [
    ['Hourly', 'Query Pipeline Health'],
    ['Query Pipeline Health', 'Evaluate Thresholds'],
    ['Evaluate Thresholds', 'Record Health Check'],
    ['Evaluate Thresholds', 'Breach?'],
    ['Breach?', 'Slack Configured?', 0],
    ['Slack Configured?', 'Post to Slack', 0],
  ], { errorWorkflow: WF_IDS.errorHandler });
}

// ================================================================ Shopify shared bits
// SHOPIFY_STORE_DOMAIN is "your-store.myshopify.com"; a full http(s):// URL is also accepted
// (used by the end-to-end tests to point at a mock).
const SHOP = "{{ ($env.SHOPIFY_STORE_DOMAIN || '').startsWith('http') ? $env.SHOPIFY_STORE_DOMAIN : 'https://' + $env.SHOPIFY_STORE_DOMAIN }}";
const SHOPIFY_GRAPHQL = `=${SHOP}/admin/api/{{ $env.SHOPIFY_API_VERSION || '2026-10' }}/graphql.json`;
const shopifyTokenNode = (n, name, position) =>
  // Dev Dashboard apps get a 24h token via the client-credentials grant, so fetch one per run.
  n.http(name, position, {
    method: 'POST', url: `=${SHOP}/admin/oauth/access_token`,
    form: [
      { name: 'grant_type', value: 'client_credentials' },
      { name: 'client_id', value: '={{ $env.SHOPIFY_CLIENT_ID }}' },
      { name: 'client_secret', value: '={{ $env.SHOPIFY_CLIENT_SECRET }}' },
    ],
  });
const shopifyConfigured = (n, name, position) =>
  n.ifNode(name, position, "={{ $env.SHOPIFY_STORE_DOMAIN && $env.SHOPIFY_CLIENT_ID ? 'yes' : '' }}", OP.notEmpty);
const slackGate = (n, name, position) =>
  n.ifNode(name, position, "={{ $env.SLACK_WEBHOOK_URL && $json.slack_text ? 'yes' : '' }}", OP.notEmpty);
const slackPost = (n, name, position) =>
  n.http(name, position, { method: 'POST', url: '={{ $env.SLACK_WEBHOOK_URL }}', body: '={{ JSON.stringify({ text: $json.slack_text }) }}' });

// ================================================================ LS-04 ERPNext Item -> Shopify draft product
function shopifyProduct() {
  const n = nodes('wf04');
  const BUILD = 'Build Shopify Product';
  return workflow('shopifyProduct', 'LS-04 ERPNext Style → Shopify: Draft Product + Sizes', [
    n.note('About', [-520, -400],
      '## LS-04 ERPNext style template → Shopify draft product\n**Trigger:** ERPNext Webhook on Item *after_insert* (style templates from LS-01 only).\n\nGets a 24h token (client-credentials grant), checks Shopify for the SKU of the first size (**idempotent**: never two products per colorway), then `productSet` creates a **DRAFT** product with a Size option and one variant per size, tagged like the live storefront (division:, print_family:, launchMMDDYY…). Merchandising owns price/imagery/publishing.\n\nGraphQL returns HTTP 200 even on failure, so the result node checks `errors` + `userErrors`.',
      500, 320),
    n.webhook('ERPNext Item Created', [0, 0], 'erpnext-item'),
    n.http('Get ERP Item', [220, 0], {
      cred: CREDENTIALS.erp, errorOutput: true, url: `=${ERP}/Item/{{ encodeURIComponent($json.body.name) }}`,
    }),
    n.code(BUILD, [440, -40], 'build-shopify-product.js'),
    shopifyConfigured(n, 'Shopify Configured?', [660, -40]),
    shopifyTokenNode(n, 'Get Shopify Token', [880, -40]),
    n.http('Find Variant by SKU', [1100, -40], {
      method: 'POST', url: SHOPIFY_GRAPHQL, errorOutput: true,
      headers: [{ name: 'X-Shopify-Access-Token', value: '={{ $json.access_token }}' }],
      body: `={{ JSON.stringify($('${BUILD}').item.json.findVariantBody) }}`,
    }),
    n.ifNode('Already on Shopify?', [1320, -80], '={{ (($json.data && $json.data.productVariants && $json.data.productVariants.nodes) || []).length > 0 }}', OP.isTrue),
    n.http('Create Draft Product', [1540, -160], {
      method: 'POST', url: SHOPIFY_GRAPHQL, errorOutput: true,
      headers: [{ name: 'X-Shopify-Access-Token', value: "={{ $('Get Shopify Token').item.json.access_token }}" }],
      body: `={{ JSON.stringify($('${BUILD}').item.json.productSetBody) }}`,
    }),
    n.code('Result: Product Created', [1780, -180], 'result-product-created.js'),
    n.code('Result: Product Exists', [1780, 0], 'result-product-exists.js'),
    n.code('Result: Shopify Error', [1780, 180], 'result-product-error.js'),
    n.postgres('Write Audit Log', [2020, 0], AUDIT_SQL, AUDIT_PARAMS),
  ], [
    ['ERPNext Item Created', 'Get ERP Item'],
    ['Get ERP Item', BUILD, 0],
    ['Get ERP Item', 'Result: Shopify Error', 1],
    [BUILD, 'Shopify Configured?'],
    ['Shopify Configured?', 'Get Shopify Token', 0],
    ['Get Shopify Token', 'Find Variant by SKU'],
    ['Find Variant by SKU', 'Already on Shopify?', 0],
    ['Find Variant by SKU', 'Result: Shopify Error', 1],
    ['Already on Shopify?', 'Result: Product Exists', 0],
    ['Already on Shopify?', 'Create Draft Product', 1],
    ['Create Draft Product', 'Result: Product Created', 0],
    ['Create Draft Product', 'Result: Shopify Error', 1],
    ...['Result: Product Created', 'Result: Product Exists', 'Result: Shopify Error'].map((r) => [r, 'Write Audit Log']),
  ], { errorWorkflow: WF_IDS.errorHandler });
}

// ================================================================ LS-05 Shopify order -> ERPNext Sales Order
function shopifyOrders() {
  const n = nodes('wf05');
  const VERIFY = 'Verify & Normalize Order';
  const MATCH = 'Match SKUs & Build Sales Order';
  return workflow('shopifyOrders', 'LS-05 Shopify Order → ERPNext: Sales Order', [
    n.note('About', [-560, -460],
      '## LS-05 Shopify order → ERPNext Sales Order\n**Trigger A:** Shopify `orders/create` webhook. **HMAC-verified over the raw body** before anything else.\n**Trigger B (hourly):** (1) pages through ALL orders from the last 6h, skipping ones the audit log shows as imported (missed webhooks); (2) re-fetches held/failed orders **by ID** (up to 7 days) so retries don\'t depend on volume.\n\n**Idempotent:** external ID = Shopify order GID (`custom_shopify_order_id`). Shopify retries webhooks, so duplicates are expected.\n\n**On hold** (not imported) if any SKU is missing, unknown or disabled in the ERP. Alert once, retry quietly.\n\nNever use the numeric `id`: it exceeds JS safe integers.',
      520, 380),
    n.rawWebhook('Shopify orders/create', [0, 0], 'shopify-orders'),
    n.schedule('Hourly Reconcile', [0, 240], { field: 'hours', hoursInterval: 1 }),
    shopifyConfigured(n, 'Shopify Configured?', [220, 240]),
    shopifyTokenNode(n, 'Get Shopify Token', [440, 320]),
    n.postgres('Load Order Sync State', [660, 320], `SELECT DISTINCT ON (entity_id) entity_id AS order_gid, status, action
FROM audit.sync_audit_logs
WHERE source_system = 'shopify' AND entity_type = 'sales_order' AND created_at > now() - interval '7 days'
ORDER BY entity_id, created_at DESC;`, null, { alwaysOutputData: true }),
    n.code('Fetch Orders to Reconcile', [880, 320], 'fetch-orders-to-reconcile.js', 'runOnceForAllItems'),
    n.code(VERIFY, [880, 100], 'verify-normalize-order.js', 'runOnceForAllItems'),
    n.ifNode('Signature Valid?', [1100, 100], '={{ $json.signatureValid }}', OP.isTrue),
    n.ifNode('Order Lines Valid?', [1320, 40], '={{ $json.valid }}', OP.isTrue),
    n.http('Find Existing Sales Order', [1540, -40], {
      cred: CREDENTIALS.erp, url: `=${ERP}/Sales Order`, errorOutput: true,
      query: [
        { name: 'filters', value: '={{ JSON.stringify([["custom_shopify_order_id", "=", $json.orderGid]]) }}' },
        { name: 'fields', value: '["name"]' },
      ],
    }),
    n.ifNode('Already Imported?', [1760, -80], '={{ ($json.data || []).length > 0 }}', OP.isTrue),
    n.http('Look Up SKUs in ERP', [1980, -20], {
      cred: CREDENTIALS.erp, url: `=${ERP}/Item`, errorOutput: true,
      query: [
        { name: 'filters', value: `={{ JSON.stringify([["name", "in", $('${VERIFY}').item.json.skus]]) }}` },
        { name: 'fields', value: '["name", "disabled", "has_variants"]' },
        { name: 'limit_page_length', value: '0' },
      ],
    }),
    n.code(MATCH, [2200, -20], 'match-order-skus.js'),
    n.ifNode('All SKUs Known?', [2420, -20], '={{ $json.allKnown }}', OP.isTrue),
    n.http('Create Sales Order', [2640, -100], {
      method: 'POST', cred: CREDENTIALS.erp, url: `=${ERP}/Sales Order`, errorOutput: true,
      body: '={{ JSON.stringify($json.salesOrder) }}',
    }),
    n.http('Submit Sales Order', [2860, -100], {
      method: 'PUT', cred: CREDENTIALS.erp, errorOutput: true,
      url: `=${ERP}/Sales Order/{{ encodeURIComponent($json.data.name) }}`,
      body: '={{ JSON.stringify({ docstatus: 1 }) }}',
    }),
    n.code('Result: Order Imported', [3100, -200], 'result-order-imported.js'),
    n.code('Result: Duplicate Skipped', [3100, -40], 'result-order-duplicate.js'),
    n.code('Result: Order Held', [3100, 120], 'result-order-held.js'),
    n.code('Result: Order ERP Error', [3100, 280], 'result-order-erp-error.js'),
    n.code('Result: Rejected Signature', [3100, 440], 'result-order-rejected.js'),
    // Poll re-sees imported orders every hour; only log duplicates that came from a webhook retry.
    n.ifNode('Webhook Duplicate?', [3340, -40], '={{ $json.source }}', OP.equals, 'webhook'),
    n.postgres('Write Audit Log', [3580, 60], AUDIT_SQL, AUDIT_PARAMS),
    slackGate(n, 'Alert Needed?', [3340, 360]),
    slackPost(n, 'Post to Slack', [3580, 340]),
  ], [
    ['Shopify orders/create', VERIFY],
    ['Hourly Reconcile', 'Shopify Configured?'],
    ['Shopify Configured?', 'Get Shopify Token', 0],
    ['Get Shopify Token', 'Load Order Sync State'],
    ['Load Order Sync State', 'Fetch Orders to Reconcile'],
    ['Fetch Orders to Reconcile', VERIFY],
    [VERIFY, 'Signature Valid?'],
    ['Signature Valid?', 'Order Lines Valid?', 0],
    ['Signature Valid?', 'Result: Rejected Signature', 1],
    ['Order Lines Valid?', 'Find Existing Sales Order', 0],
    ['Order Lines Valid?', 'Result: Order Held', 1],
    ['Find Existing Sales Order', 'Already Imported?', 0],
    ['Find Existing Sales Order', 'Result: Order ERP Error', 1],
    ['Already Imported?', 'Result: Duplicate Skipped', 0],
    ['Already Imported?', 'Look Up SKUs in ERP', 1],
    ['Look Up SKUs in ERP', MATCH, 0],
    ['Look Up SKUs in ERP', 'Result: Order ERP Error', 1],
    [MATCH, 'All SKUs Known?'],
    ['All SKUs Known?', 'Create Sales Order', 0],
    ['All SKUs Known?', 'Result: Order Held', 1],
    ['Create Sales Order', 'Submit Sales Order', 0],
    ['Submit Sales Order', 'Result: Order Imported', 0],
    ['Submit Sales Order', 'Result: Order ERP Error', 1],
    ['Create Sales Order', 'Result: Order ERP Error', 1],
    ['Result: Duplicate Skipped', 'Webhook Duplicate?'],
    ['Webhook Duplicate?', 'Write Audit Log', 0],
    ...['Result: Order Imported', 'Result: Order Held', 'Result: Order ERP Error', 'Result: Rejected Signature']
      .map((r) => [r, 'Write Audit Log']),
    ...['Result: Order Held', 'Result: Order ERP Error', 'Result: Rejected Signature'].map((r) => [r, 'Alert Needed?']),
    ['Alert Needed?', 'Post to Slack', 0],
  ], { errorWorkflow: WF_IDS.errorHandler });
}

// ================================================================ LS-06 Launch critical path
function criticalPath() {
  const n = nodes('wf06');
  const table = (name) => `=https://api.airtable.com/v0/{{ $env.AIRTABLE_BASE_ID }}/${encodeURIComponent(name)}`;
  const load = (name, tableName, position) => n.http(name, position, {
    cred: CREDENTIALS.airtable, url: table(tableName), airtablePages: true, executeOnce: true,
    query: [{ name: 'pageSize', value: '100' }],
  });
  return workflow('criticalPath', 'LS-06 Launch Critical Path', [
    n.note('About', [-500, -420],
      '## LS-06 Launch critical path\n**Weekdays 13:00 UTC.** For every colorway, counts back from the launch date: PP sample approved (T-90, Production), licensor approval (T-75, licensed prints only), compliance passed (T-60, Compliance & Integrity), photography delivered (T-30, Photography), synced to ERP (T-21, Systems).\n\n1. Writes status back to **Colorways**, only fields that changed (no changes = no API calls)\n2. Snapshots every milestone to `audit.colorway_milestones` (days-per-stage SQL)\n3. ONE Slack digest grouped by team, not one ping per colorway\n\nLead times live in `shared/product_model.json`.',
      560, 340),
    n.schedule('Weekdays 13:00 UTC', [0, 0], { field: 'cronExpression', expression: '0 13 * * 1-5' }),
    load('Load Colorways', 'Colorways', [220, 0]),
    load('Load Style Master', 'Style Master', [440, 0]),
    load('Load Prints', 'Prints', [660, 0]),
    load('Load Samples', 'Samples', [880, 0]),
    load('Load Compliance Tests', 'Compliance Tests', [1100, 0]),
    load('Load Photo Shots', 'Photo Shots', [1320, 0]),
    n.code('Compute Critical Path', [1540, 0], 'compute-critical-path.js', 'runOnceForAllItems'),
    n.code('Batch Colorway Updates', [1780, -180], 'batch-colorway-updates.js', 'runOnceForAllItems'),
    n.http('Update Colorways', [2000, -180], {
      method: 'PATCH', cred: CREDENTIALS.airtable, url: table('Colorways'),
      body: '={{ JSON.stringify($json) }}', batching: AIRTABLE_BATCHING,
    }),
    n.code('Milestone Snapshot', [1780, 0], 'milestone-snapshot.js', 'runOnceForAllItems'),
    n.postgres('Save Milestone Snapshot', [2000, 0], `INSERT INTO audit.colorway_milestones
  (run_id, colorway_record_id, colorway_name, sku_base, launch_date, milestone, owner_team, due_date, completed_on, status, days_late)
SELECT $1, r.colorway_record_id, r.colorway_name, r.sku_base, r.launch_date::date, r.milestone, r.owner_team,
       r.due_date::date, r.completed_on::date, r.status, r.days_late
FROM jsonb_to_recordset($2::jsonb) AS r(colorway_record_id text, colorway_name text, sku_base text, launch_date text,
     milestone text, owner_team text, due_date text, completed_on text, status text, days_late int);`,
      '={{ [String($execution.id), $json.rows] }}'),
    n.code('Team Digest', [1780, 200], 'team-digest.js', 'runOnceForAllItems'),
    slackGate(n, 'Alert Needed?', [2000, 200]),
    slackPost(n, 'Post to Slack', [2220, 180]),
  ], [
    ['Weekdays 13:00 UTC', 'Load Colorways'],
    ['Load Colorways', 'Load Style Master'],
    ['Load Style Master', 'Load Prints'],
    ['Load Prints', 'Load Samples'],
    ['Load Samples', 'Load Compliance Tests'],
    ['Load Compliance Tests', 'Load Photo Shots'],
    ['Load Photo Shots', 'Compute Critical Path'],
    ['Compute Critical Path', 'Batch Colorway Updates'],
    ['Batch Colorway Updates', 'Update Colorways'],
    ['Compute Critical Path', 'Milestone Snapshot'],
    ['Milestone Snapshot', 'Save Milestone Snapshot'],
    ['Compute Critical Path', 'Team Digest'],
    ['Team Digest', 'Alert Needed?'],
    ['Alert Needed?', 'Post to Slack', 0],
  ], { errorWorkflow: WF_IDS.errorHandler });
}

// ---------------------------------------------------------------- write
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  mkdirSync(OUT, { recursive: true });
  const outputs = {
    'LS-00_global_error_handler.json': errorHandler(),
    'LS-01_airtable_to_erpnext_sku.json': skuProvision(),
    'LS-02_erpnext_po_to_airtable.json': poDelivery(),
    'LS-03_pipeline_health_check.json': freshness(),
    'LS-04_erpnext_item_to_shopify.json': shopifyProduct(),
    'LS-05_shopify_order_to_erpnext.json': shopifyOrders(),
    'LS-06_launch_critical_path.json': criticalPath(),
  };
  for (const [file, wf] of Object.entries(outputs)) {
    writeFileSync(join(OUT, file), JSON.stringify(wf, null, 2) + '\n');
    console.log(`wrote n8n/workflows/${file}  (${wf.nodes.length} nodes)`);
  }
}

export { errorHandler, skuProvision, poDelivery, freshness, shopifyProduct, shopifyOrders, criticalPath };
