# Runbook: Airtable ↔ ERPNext Product Sync

| | |
|---|---|
| **Service** | Style → SKU provisioning (LS-01) and PO → delivery updates (LS-02) |
| **Owner** | Systems team (primary), with a named backup owner |
| **Business impact if down** | New SKUs don't reach the ERP, so POs can't be raised and launches slip. Production loses PO visibility in Airtable. |
| **Severity guide** | **SEV2:** all syncs failing, or a launch ≤ 7 days away is blocked. **SEV3:** individual records failing. **SEV4:** cosmetic or monitoring issues. |
| **Dashboards** | n8n → Executions · Adminer `analytics.sku_latest_sync` · `sql/analytics/05_stuck_skus.sql` |

---

## 1. System overview

```
Airtable (Colorways) ──webhook {recordId}──▶ n8n LS-01 ──REST──▶ ERPNext style template + size variants
        ▲    ▲                              │  └─ every 6h safety-net poll of approved, unsynced records
        │    └──── PATCH status/ERP code ───┤
        │                                   └──▶ Postgres audit.sync_audit_logs
        │
        └──── PATCH PO fields ──── n8n LS-02 ◀── ERPNext Webhook (PO submit / update-after-submit)
                                            └─ hourly poll of recently modified POs
n8n LS-00 = error workflow (crashes → audit.workflow_errors + Slack)
n8n LS-03 = hourly health check (staleness + error rate → audit.pipeline_health_checks + Slack)
```

**Source of truth.** Airtable owns *product/style* attributes (name, fabric, category, cost at approval). ERPNext owns *items, purchasing and inventory* once an item exists. n8n owns the sync fields on both sides (`Sync Status`, `ERP Item Code`, `Last Sync Error`, `custom_airtable_record_id`).

**Join key.** `ERPNext Item.custom_airtable_record_id` = Airtable record ID. This is the external ID, the equivalent of NetSuite's `externalId`. LS-01 looks it up first, so re-running a sync is always safe (idempotent upsert).

## 2. Endpoints and authentication

| System | Base URL (POC) | Auth | Where the secret lives |
|---|---|---|---|
| ERPNext REST | `http://frontend:8080/api/resource/…` (docker) · `http://localhost:8080` (host) | `Authorization: token <api_key>:<api_secret>` for user `integration@littlesleepies.local` | n8n credential *ERPNext API (integration user)* |
| Airtable REST | `https://api.airtable.com/v0/{baseId}/Colorways` (+ Style Master, Prints, Size Codes…) | `Authorization: Bearer <PAT>` (scopes: data.records:read/write, schema.bases:read/write) | n8n credential *Airtable PAT* |
| n8n inbound webhooks | `/webhook/airtable-approved`, `/webhook/erpnext-po` | Header `X-LS-Webhook-Token` | n8n credential *LS Inbound Webhook Token*; ERPNext Webhook headers; Airtable automation script |
| Warehouse | `warehouse:5432` / `localhost:5433` db `ls_warehouse` | user/password | n8n credential *LS Warehouse (Postgres)* |

**Rotating the ERPNext key.** Run `python scripts/setup_erpnext.py --rotate-keys --write-env`, then `npm run n8n:import`, or edit the credential in the n8n UI. The old secret stops working immediately, so do this in a quiet window.
**Rotating the webhook token.** Update `.env`, the n8n credential, both ERPNext Webhook docs (Webhook Headers), and the Airtable automation script, *in that order*. Expect 401s from any sender you haven't updated yet. The polls cover the gap.

## 3. Error handling and retry behaviour

| Failure | Where it surfaces | Automatic behaviour | Human action |
|---|---|---|---|
| **Validation** (missing cost, compliance not passed, bad colorway number, empty size run) | Airtable `Sync Status = Error` with a `Validation: …` message | Never calls the ERP. Not retried. | Production fixes data, then sets **Sync Status → Pending** (or runs `data_quality_audit.js` to bulk-retry). |
| **409 Conflict / DuplicateEntryError** | `Sync Status = Error`, `ERP duplicate: …` | None: it's permanent, and retrying can't fix it | Usually an Item created by hand with the same code and no `custom_airtable_record_id`. Decide which is canonical. Either set the Airtable record ID on the existing Item (then retry), or rename the manual one. |
| **417 Validation / LinkValidationError** | `Error`, `ERP validation: HTTP 417 — LinkValidationError — Could not find Item Group: …` | None (permanent) | Master data missing in ERPNext (Item Group, Brand, UOM). Create it, or re-run `setup_erpnext.py`, then set Pending. |
| **401 / 403** | `Error`, `ERP auth` / `ERP permission` on *every* record | None (permanent) | Key rotated, user disabled, or role changed. Check the user in ERPNext → API Access. Re-issue keys. **SEV2 if all records are failing.** |
| **429** (Airtable) | n8n execution error on the write-back, or `skipped`/`failed` PO rows | n8n batches 5 req per 1.1 s. The Airtable **write-back** node retries 3× with 2 s waits. | If persistent: another integration is sharing the base's 5 req/s budget. Find it, then stagger the schedules. |
| **5xx / network** (ERPNext down, Docker restart) | `Sync Status = Pending`, `Temporary ERP problem (server/network), will retry automatically…` | Record goes back to **Pending**. The next safety-net poll (≤ 6 h) retries it | Restore ERPNext (§5). To retry sooner, run the LS-01 poll manually. `05_stuck_skus.sql` lists what's waiting. |

> **n8n gotcha (verified on n8n 2.39.6 with an end-to-end test):** *Retry On Fail* does **not** retry a node whose *On Error* is set to *Continue (using error output)*. The error goes straight down the error branch after one attempt. ERP calls here need the error branch so they can write back to Airtable. Their retry mechanism is therefore "transient → Pending → the poll retries", not node retries. `tests/js/workflows.test.mjs` fails the build if anyone adds Retry On Fail to an error-output node, since it would silently do nothing.
| **Config change not picked up** (e.g. `.env` edited, n8n still calls `…/v0//Colorways` and gets 404) | Every Airtable node fails. The URL in the failed node shows an empty `{{ $env.… }}` value | none | Containers read environment variables only at creation: `docker compose up -d n8n` recreates it (data in the `n8n-data` volume is kept). Check with `docker compose exec n8n printenv AIRTABLE_BASE_ID` |
| **n8n crashes mid-run** (node without an error branch fails, e.g. Airtable write-back) | LS-00 → `audit.workflow_errors` + Slack | none | Open the execution URL in the alert, fix, then **Retry** the execution from n8n (Executions → Retry with original/current workflow). |
| **Webhook never arrives** (tunnel down, Airtable automation run quota hit) | Nothing. That's the danger. | Safety-net polls: LS-01 every 6 h, LS-02 hourly | LS-03 alerts if there's no successful sync in 24 h. Check the Airtable automation run history. |

**Why the webhook carries only an ID.** n8n always re-reads the record from the source API before writing. A delayed or replayed webhook therefore can't push stale data, and a spoofed payload can't inject values.

## 4. Monitoring and alerts

| Signal | Mechanism | Threshold | Goes to |
|---|---|---|---|
| Workflow crash | LS-00 error workflow (set as *Error Workflow* on LS-01 to LS-06) | any | Slack + `audit.workflow_errors` |
| Pipeline stale or silent | LS-03 hourly | no success in 24 h, or < 1 event/24 h | Slack + `audit.pipeline_health_checks` |
| Error rate | LS-03 hourly | > 10 % of attempts in 24 h | Slack |
| Drift between systems | `python scripts/reconcile.py --write-warehouse --fail-on-drift` (schedule nightly) | any finding | `audit.reconciliation_findings`, plus non-zero exit for the scheduler |
| dbt source freshness | `dbt source freshness` | warn 6 h / error 24 h | CI / scheduler |

Tune thresholds in `n8n/src/code/evaluate-freshness.js`, then `npm run build` and re-import.

## 5. Incident response

**Step 0. Acknowledge.** Post in the systems channel: *"Looking at SKU sync failures, next update in 30 min."* Stakeholders want to know someone owns it before they want the fix.

**Step 1. Scope it** (5 min)
```sql
-- How bad, since when?
SELECT date_trunc('hour', created_at) h, status, http_status, count(*)
FROM audit.sync_audit_logs WHERE created_at > now() - interval '24 hours'
GROUP BY 1,2,3 ORDER BY 1 DESC;
```
- **Every** record failing with the same status → a systemic cause (auth, ERP down, schema change). Go to step 2.
- **Some** records failing → data. Run `sql/analytics/04_top_failure_reasons.sql` and route to the data owner.

**Step 2. Check the dependencies, in order**
1. `docker compose ps`. Are `frontend`, `backend`, `db`, `n8n` and `warehouse` all *running*?
   - `n8n` exited, or the n8n login at :5678 says *wrong username or password*: another n8n (e.g. a standalone `docker run` container with `restart=always`) is holding port 5678, so you're on a different instance. Find it with `docker ps -a | findstr 5678`, then `docker update --restart=no <name>`, `docker stop <name>`, and `docker compose up -d --force-recreate n8n` (a plain `up` can reuse a container created without its port binding). Check: `docker port little-sleepies-proof-of-concept-n8n-1` shows `0.0.0.0:5678`.
2. ERPNext: `curl -s -o NUL -w "%{http_code}" http://localhost:8080/api/method/ping` should return `200`.
3. Credential check: `curl -H "Authorization: token KEY:SECRET" http://localhost:8080/api/method/frappe.auth.get_logged_user` should return the integration user.
4. ERPNext **Error Log** list (`/app/error-log`) and **Webhook Request Log** (`/app/webhook-request-log`) for outbound PO webhooks.
5. n8n Executions: filter by *Error*, open the latest, and read the failing node's input and output.
6. Airtable: Automations → run history (quota exhausted? script error?).

**Step 3. Mitigate before you fix.** If ERPNext is down for a while, *deactivate* LS-01 so records don't all pile into Error. Approvals stay *Pending*, and the poll catches up after you re-activate. Tell Production that approvals are queued, not lost.

**Step 4. Recover the backlog**
```sql
-- Records whose latest attempt failed (feed this list to Production or the bulk-retry script)
\i sql/analytics/05_stuck_skus.sql
```
Set those records to **Pending** in Airtable (or use `data_quality_audit.js`), then run LS-01's poll manually: open the workflow → *Safety-Net Poll* → **Execute step**.

**Step 5. Verify.** Run `python scripts/reconcile.py` and confirm it reports *No drift*. On this POC, the seeded Rainbow Stripes finding is the baseline (see *Reading the drift report* in §6).

**Step 6. Follow through**
Write a short post-incident note: timeline, impact (SKUs delayed, for how long), root cause, what detected it (and whether it should have been detected sooner), and the action items with owners. Fold any new failure mode into §3 of this runbook.

## 6. Routine operations

| Task | How |
|---|---|
| Retry one record | Airtable: Sync Status → **Pending** (webhook fires if the automation is on, else wait for or run the poll) |
| Retry many | `airtable/scripts/data_quality_audit.js` → "Yes, retry" |
| Re-sync an item after a cost change | Set Pending. LS-01 finds the item by external ID and **updates** it. |
| Add a new synced field | 1) Airtable field 2) ERPNext Custom Field (add to `CUSTOM_FIELDS` in `setup_erpnext.py`) 3) map it in `transformColorway()` (`n8n/src/lib/product-model.js`) + a test, and add it to `VARIANT_FIELDS` if sizes should inherit it 4) `npm test && npm run build` 5) re-import LS-01 6) update §1 and the field table in `airtable/SCHEMA.md` |
| Deploy a workflow change | Edit `n8n/src/**` → `npm test` → `npm run build` → `docker compose exec n8n n8n import:workflow --input=/workflows/<file>` → re-activate (import deactivates it: `docker compose exec n8n n8n publish:workflow --id=<id>`, then `docker compose restart n8n`) → confirm with `n8n list:workflow --active=true`. **From Git Bash**, prefix with `MSYS_NO_PATHCONV=1`, or it rewrites `/workflows/…` into a Windows path and the import fails with `ENOENT … D:/…/Git/workflows/…`. Never hand-edit production workflows without exporting back to git. |
| Back up | `docker compose exec n8n n8n export:workflow --all --separate --output=/home/node/.n8n/exports`; ERPNext: `docker compose exec backend bench --site frontend backup --with-files` |
| Purge demo data | `DELETE FROM audit.sync_audit_logs WHERE workflow_name = 'demo-seed';` |

### Reading the drift report

`reconcile.py` compares Airtable Colorways with ERPNext style templates and their size variants, and lists every place they disagree. It is **read-only** on both systems: it reports, and a person decides which side is right (see *Source of truth* in §1). Run it nightly, after an incident (§5 step 5), and after any bulk import or hand edit in the ERP.

```
docker compose --profile tools run --rm tools python scripts/reconcile.py                    # console summary + CSV
docker compose --profile tools run --rm tools python scripts/reconcile.py --write-warehouse  # also load into audit.reconciliation_findings
```
Add `--fail-on-drift` when a scheduler runs it: the script then exits 1 if there's any finding.

**Where the output goes**
- **Console:** a count per kind, then the first 25 findings.
- **CSV:** `reports/drift_<UTC timestamp>.csv`, with **every** finding. Written only when there is drift: a clean run prints *No drift. Systems agree.* and writes no file. `reports/` is gitignored, so reports never reach git.
- **Warehouse** (with `--write-warehouse`): one row per finding in `audit.reconciliation_findings`, stamped with `run_at`, so you can trend drift over time.

**Columns:** `kind` (below) · `airtable_record_id` (the Colorway, `rec…`) · `sku` (style SKU, e.g. `S-0108-0911`) · `field` (what disagrees) · `airtable_value` · `erp_value`. A blank value means "nothing there".

Only colorways that are **Approved for Production** with **Compliance Status = Passed** are checked. Anything earlier isn't supposed to be in the ERP yet; LS-06 reports those. Matching is on `custom_airtable_record_id`, not on SKU.

| `kind` | What it means | Likely cause | What to do |
|---|---|---|---|
| `missing_in_erp` | Ready and compliant in Airtable, but no ERP template carries its record ID. (Records in *Error* are skipped: they failed validation and are expected to be missing) | Sync never ran or was dropped; status set to *Synced* by hand; an item with that SKU was made by hand without the record ID | Search ERPNext Items for the SKU. **None:** set Sync Status → Pending and LS-01 creates it. **Exists but unlinked:** decide which is canonical, set `custom_airtable_record_id` on it (API or Data Import), then Pending: LS-01 now updates it. If the record is already *Pending*, it may just be queued: re-run after the next poll |
| `orphan_in_erp` | An ERP template points to an Airtable record that no longer exists | Colorway deleted in Airtable | Find out why it was deleted. Style cancelled: **disable** the item in ERPNext, don't delete it (POs and orders may reference it). Deleted by mistake: restore it from the base's trash if you still can. A re-created record gets a new ID, so update `custom_airtable_record_id` on the item to match |
| `field_mismatch` | Division, Launch Date, Colorway Number or Cost Price differ. Cost allows half a cent of rounding | Someone edited one side by hand; a master-data rename | Airtable owns these fields by default: set the record to Pending and LS-01 overwrites the ERP. If the ERP edit was deliberate (e.g. Finance corrected a cost), make the same change in Airtable instead, and ask why it was made in the ERP first |
| `writeback_missing` | The ERP template exists, but Airtable doesn't say *Synced* with that SKU in ERP Item Code | LS-01 created the item, then the update back to Airtable failed (deleted field, rate limit, token) | Check the audit log for that SKU's failed Airtable update and fix the cause. Then set Pending: LS-01 finds the item by external ID (no duplicate) and writes the status back |
| `variants_missing` | Fewer size variants in the ERP than the style's size run lists. `airtable_value` = expected, `erp_value` = actual | Background variant job failed or is still queued; a size was added to the size run | See §10: check `docker compose logs queue-long`, then set the colorway to Pending (existing sizes are skipped) |

**Known seeded finding.** `missing_in_erp, …, S-0108-0911, Sync Status, Synced, (blank)` is **Rainbow Stripes Zippy**, seeded with `"synced": true` but never created in the ERP (`airtable/seed_product_model.json`), so the drift report always has a real example. So on this POC, **one finding is the clean baseline**, and `--fail-on-drift` always exits 1 until you resolve it.

**Trend query** (needs `--write-warehouse` runs):
```sql
SELECT run_at::date AS day, kind, count(*) AS findings
FROM audit.reconciliation_findings
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;
```
A kind that keeps coming back points to a process gap, not a one-off. For example, repeated `field_mismatch` on Cost Price means people are editing cost in the ERP: fix the process or the ownership, not just the rows.

## 7. Known limitations (POC)

- One PO number is stored per style (the latest). Real life would use a linked *POs* table.
- The webhook token is a shared secret in headers. Production should add HMAC signature verification (ERPNext supports a webhook secret → `X-Frappe-Webhook-Signature`) and run n8n behind TLS with an IP allowlist.
- n8n runs in single-instance mode. Production would use queue mode (Redis + workers) and Postgres as n8n's own database.
- Cost is synced as `valuation_rate` only. A real NetSuite design would also set the purchase price on the item-vendor sublist.

## 8. Shopify order and product sync (LS-05, LS-04)

```
Shopify orders/create ──signed webhook──▶ n8n LS-05 ──verify HMAC → dedupe → match SKUs──▶ ERPNext Sales Order (draft → submit)
        ▲                                     └─ hourly reconcile: (1) all orders from the last 6 h not yet imported, (2) held/failed orders re-fetched by ID for 7 days
        └─ draft product ◀── n8n LS-04 ◀── ERPNext Webhook: Item after_insert (synced items only)
```

**Auth.** A Shopify **Dev Dashboard app** (admin-created custom apps were retired on 1 Jan 2026). n8n exchanges `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` for an access token through the **client-credentials grant**. The token lasts **24 h**, so the workflows fetch a fresh one each run. The same client secret signs webhooks.

**Idempotency.** Sales Order `custom_shopify_order_id` = Shopify order **GID** (`gid://shopify/Order/…`). Never use the numeric `id`: it is larger than JavaScript can represent exactly, and `JSON.parse` silently rounds it. LS-04 checks Shopify for the SKU before creating a product.

**Configuration flag.** Until `SHOPIFY_STORE_DOMAIN` and `SHOPIFY_CLIENT_ID` are set, the poll (LS-05) and product creation (LS-04) skip quietly. The webhook path still works with `scripts/send_test_order.py`.

| Symptom | Cause | Automatic | Action |
|---|---|---|---|
| Order **ON HOLD: Unknown SKU …** (Slack + audit) | Shopify variant SKU has no ERP item (typo, item never synced, variant added in Shopify only) | The hourly reconcile re-fetches every held order **by ID** for 7 days, however many other orders arrive | Create or fix the item in the ERP (or the variant SKU in Shopify). The next hourly run imports the order. **No manual replay needed** within 7 days. After that, re-send it from Shopify or create the Sales Order by hand |
| **ON HOLD: Line "…" has no SKU** | Gift card, tip, custom item, or a variant missing its SKU | Same | Give the variant a SKU, or decide that line type should be skipped (code change in `normalizeShopifyOrder`) |
| **ON HOLD: SKU … is disabled** | Item disabled in the ERP but still sold online | Same | Re-enable, or unpublish the product in Shopify |
| **Rejected: invalid signature** (`verify_signature`, 401) | One forged request, **or every request** because the app's client secret was rotated | none | One-off: ignore, it was correctly blocked. All orders: update `SHOPIFY_CLIENT_SECRET` in `.env` → `docker compose up -d n8n`. The reconcile then imports rejected orders from the **last 6 h**. Anything older needs a manual re-import |
| `skipped: Already imported as SAL-ORD-…` | Shopify retried the webhook (it retries 8× over 4 h on any non-200 or timeout) | Idempotency: nothing created | None. Only webhook duplicates are logged. Poll re-sightings aren't, to keep the log clean |
| Order import failed: ERP 417 / 5xx | ERP validation (fiscal year, warehouse, customer) or ERP down | Poll retries every hour | Read the message. 417 → fix the master data. 5xx → restore ERPNext (§5) |
| Sales Order exists but is **Draft** | Created, but the submit call failed | none: the next poll sees the draft as "already imported" | Open it in ERPNext and Submit, or delete it so the poll re-imports |
| No orders arriving at all | Tunnel URL changed (quick tunnels get a new URL each start), or Shopify deleted the subscription after 8 failed deliveries | Poll still imports within the hour | `docker compose logs tunnel` → new URL → `python scripts/setup_shopify.py --webhook-base-url https://<new>` |
| LS-04 `Shopify rejected productSet: …` | GraphQL `userErrors` (validation). Note it arrives with **HTTP 200** | none | Fix the item data. Re-run by re-saving won't re-trigger (after_insert only), so execute LS-04 manually with the item name |
| `THROTTLED` / `ACCESS_DENIED` from GraphQL | Cost-based rate limit, or the app lacks a scope (`read_orders`, `read_products`, `write_products`) | none | Throttled: retry later. Access denied: add the scope in the Dev Dashboard app, release a new version, reinstall it on the store |

**How the hourly reconcile works.** It reads the audit log first. It pages through *every* order created in the last 6 h (Shopify stops retrying a webhook after about 4 h) and skips the ones already imported, so a busy hour doesn't mean thousands of ERP lookups. Then it re-fetches held or failed orders by ID. Each page of 25 orders stays under Shopify's 1,000-point query-cost limit, `THROTTLED` responses back off and retry, and a 200-page cap (5,000 orders) stops a runaway loop. The cap shows as `pollStats.truncated: true` on the first item in the n8n execution. The first version of this poll asked for `first: 50` with no paging, so above 50 orders it only ever saw the oldest ones. A review caught it, and `tests/js/shopify.test.mjs` now checks that the newest order is reached.

**Useful queries**
```sql
-- Orders currently on hold or failing (latest attempt per order)
SELECT DISTINCT ON (entity_id) payload->>'order_name' AS order_no, status, error_message, created_at
FROM audit.sync_audit_logs WHERE source_system = 'shopify' AND entity_type = 'sales_order'
ORDER BY entity_id, created_at DESC;
```
See also `sql/analytics/07_shopify_order_exceptions.sql`.

**Known limitations (POC).** Shipping lines, discounts, taxes and refunds aren't mapped, so ERP totals will differ from Shopify totals. That's the most common real-world reconciliation gap, and the next thing to build. One channel customer is used for every order (no per-customer records, and no PII in the ERP). Fulfilment and tracking don't flow back to Shopify.


## 9. Launch critical path (LS-06)

**What it does.** Weekdays at 13:00 UTC it reads all seven product-model tables (following Airtable's page cursor, so every record is included). For each colorway it computes the milestones against the launch date, then:
- writes status back to **Colorways**, sending **only the fields that changed** (a quiet day costs one read per table and zero writes)
- snapshots every milestone to `audit.colorway_milestones` in one INSERT
- sends **one** Slack digest grouped by owning team, plus a "Data issues" section, rather than one ping per colorway

| Symptom | Cause | Action |
|---|---|---|
| Colorway shows `⚠ Data: Colorway Number "91" must be 4 digits` | Bad or missing colorway number, style or print link | Fix the record. The next run recomputes the SKU base. A data issue alone makes the timeline **At Risk**, because a malformed SKU would block the ERP sync |
| `Unknown Compliance Profile` | The style's profile isn't in `shared/product_model.json` | Set the profile on the Style Master, or add the profile (and its required tests) to the JSON, then `npm run build` and re-import LS-06 |
| Compliance stuck "In Testing" | A required test type has no Passed / Not Applicable row | The Critical Path text names the missing types. Add or update the test rows |
| Timeline didn't change after editing Airtable | LS-06 runs on a schedule | Run it manually in n8n (Execute workflow), or wait for the next weekday run |
| Digest numbers disagree with `08_launch_risk_by_team.sql` | The view shows the **latest run only** | Check `SELECT MAX(captured_at) FROM audit.colorway_milestones`: did today's run fail? (LS-00 alerts on crashes) |
| Lead times need changing | They're configuration | Edit `milestones` in `shared/product_model.json` → `npm test && npm run build` → re-import LS-06 |

**Rebuild the demo data:** `python scripts/setup_product_model.py --reset --seed`. This deletes and re-seeds only the seven product-model tables, nothing else. Seed dates are relative to today, so the board always shows a mix of on-track, at-risk, late and complete. **Only do this while ERPNext has no synced items.** Re-seeding gives every colorway a new record ID. The existing ERP templates keep the old IDs, so the next sync can't find them and fails with 409 duplicates.


## 10. Style templates and size variants (LS-01)

A colorway becomes an ERPNext **template** (`S-0108-0901`, `has_variants = 1`), and each size a **variant** (`S-0108-0901-10`). LS-01 sends ONE request per colorway to `erpnext.controllers.item_variant.enqueue_multiple_variant_creation`. ERPNext creates up to 9 variants immediately (the audit row shows the count), queues 10 or more to a background worker (the audit row shows `queued`), and always skips sizes that already exist, so re-running is safe.

| Symptom | Cause | Action |
|---|---|---|
| Template exists but has no / too few variants | Background variant job failed or is still queued (two-piece sets have 10 sizes) | `python scripts/reconcile.py` reports `variants_missing`. Check the RQ worker: `docker compose logs queue-long`. Set the colorway to Pending to re-request (existing sizes are skipped) |
| A size was added to a style's Size Run | New sizes only exist after the next sync of each colorway | Set the affected colorways to Pending, or wait for the reconcile report to flag `variants_missing` |
| `Size Run includes non-Sleep sizes` | A Play size code was linked to a Sleep style (codes differ per division) | Fix the Style Master's Size Run |
| `No size code for … in division …` | A size label isn't in `shared/product_model.json` | Add it (and its code) there and to the ERPNext attribute (`setup_erpnext.py` adds missing values), then `npm run build` |
| 417 on update: cannot change attributes / has_variants | Template-only fields sent on update | Shouldn't happen: LS-01 sends `updatePayload` without them. If it does, check `transformColorway()` |
| Shopify order held: `is a style template, not a size` | The Shopify variant's SKU is the base without a size code | Fix the variant SKU in Shopify. The hourly reconcile then imports the order |
| Variant names look like "Woodland Fox Zippy-10" | ERPNext names variants with the attribute *abbreviation* (the size code) | Cosmetic. Shopify titles come from the template plus the Size option |
