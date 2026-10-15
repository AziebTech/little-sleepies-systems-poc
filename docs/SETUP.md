# Setup

One path from an empty machine to a working stack. Each step ends with a **Check**: don't move on until it passes. Steps 8 and 9 are optional.

Run commands from the repo root in PowerShell. Python scripts run inside the `tools` container, so you don't need Python installed. In this guide, `tools` is short for:

```
docker compose --profile tools run --rm tools python
```

## 1. Configure
1. Install **Docker Desktop** (running) and **Node 20+**.
2. `copy .env.example .env`
3. Set `LS_WEBHOOK_TOKEN` in `.env` to the output of `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.

**Check:** `npm test` prints `# fail 0`.

## 2. Start the containers
1. `docker compose up -d`
2. The first start builds the ERPNext site (about 5 minutes). Follow it with `docker compose logs -f create-site` until that container exits.

**Check:** `docker compose ps` lists backend, frontend, n8n, warehouse and adminer as running.

## 3. ERPNext
1. Open http://localhost:8080, log in as `Administrator` / `admin`, and finish the setup wizard: United States, USD, company **Little Sleepies Demo**.
2. `docker compose --profile tools build` (first time only).
3. `tools scripts/setup_erpnext.py --write-env`. It creates item groups, size attributes, custom fields, the *LS Production User* role, the integration user and its API key, and the webhooks. It writes the key into `.env`.

**Check:** in ERPNext, open any Item. There's a **Little Sleepies** tab with fields like Airtable Record ID and Launch Date.

## 4. Airtable
1. Create an empty base (any name). Copy its ID (`app…`, from the URL) into `AIRTABLE_BASE_ID`.
2. Create a personal access token at https://airtable.com/create/tokens with scopes `data.records:read`, `data.records:write`, `schema.bases:read` and `schema.bases:write`, and give it access to that base only. Put it in `AIRTABLE_PAT`.
3. `tools scripts/setup_product_model.py --seed`

**Check:** the base has 7 tables (Style Master, Prints, Size Codes, Colorways, Samples, Compliance Tests, Photo Shots), and Colorways has 14 rows. Delete any other tables, such as the default *Table 1*. Nothing reads them.

> **Never run `--reset` once ERPNext has items.** It deletes and re-creates every Airtable record, so every record ID changes. The ERP items still carry the old IDs, so the next sync can't find them and fails with 409 duplicates.

## 5. n8n
1. Open http://localhost:5678 and create the owner account.
2. `npm run n8n:import`. This imports 4 credentials, built from `.env` and streamed into the container (no secrets file is written to disk), and 7 workflows.
3. Publish every workflow: open each one and click **Publish** (top right). Importing un-publishes a workflow, so do this after every import.
4. In each workflow's **Settings**, confirm *Error Workflow* is **LS-00**.

**Check:** the Workflows list shows LS-00 to LS-06, all published.

If you run the import from Git Bash instead of PowerShell, prefix it with `MSYS_NO_PATHCONV=1`. Otherwise Git Bash rewrites the container paths and the import fails with `ENOENT`.

## 6. First sync
Order matters here. LS-01 only syncs colorways whose Compliance Status is *Passed*, and LS-06 is what computes that status.

1. Open **LS-06** → **Execute workflow**.
2. Open **LS-01** → execute the **Safety-Net Poll** node.

**Check:** in Airtable, Colorways that were ready show Sync Status **Synced** and an ERP Item Code like `S-0108-0907`. In ERPNext, that item is a template with one variant per size (`S-0108-0907-01` …).

## 7. Purchase orders and the warehouse
1. `tools scripts/simulate_po.py` submits a PO in ERPNext. Its webhook triggers LS-02.
2. Open Adminer at http://localhost:8081: System **PostgreSQL**, Server **warehouse**, and the user, password and database from the `WAREHOUSE_*` lines in `.env`.

**Check:** the colorway in Airtable now has PO Number, PO Qty and Expected Delivery filled in. In Adminer, `audit.sync_audit_logs` has rows.

## 8. Shopify (optional)
**Without a store.** Leave any placeholder in `SHOPIFY_CLIENT_SECRET`. Then `tools scripts/send_test_order.py` sends a correctly signed fake order to LS-05.
**Check:** a Sales Order appears in ERPNext.

**With a free dev store:**
1. At https://dev.shopify.com create an organization if asked, then **Dev stores → Create store**, with *Generate test data* **off**.
2. **Apps → Create app**. Give the version the Admin API scopes `read_orders`, `read_products` and `write_products`, release it, and install it on the dev store.
3. Put the app's Client ID and secret, and the `your-store.myshopify.com` domain, into `.env`. Then run `docker compose up -d n8n`, because containers only read `.env` when they're created.
4. `tools scripts/setup_shopify.py --backfill-products` checks the connection and creates draft products.
5. `docker compose --profile tunnel up -d`. Copy the `https://….trycloudflare.com` URL from `docker compose logs tunnel`, then run `tools scripts/setup_shopify.py --webhook-base-url <that URL>`.

**Check:** set a product to Active, create an order for it in the Shopify admin and mark it paid. A Sales Order appears in ERPNext.

The tunnel URL changes every time the tunnel restarts. Re-run step 5 after each restart.

## 9. Airtable webhook (optional)
Without this step, LS-01 still syncs through its 6-hourly poll or a manual run.
1. Start the tunnel (step 8.5). In `airtable/scripts/automation_notify_n8n.js`, set `N8N_WEBHOOK_URL` to the tunnel URL and `WEBHOOK_TOKEN` to your `LS_WEBHOOK_TOKEN`.
2. In Airtable go to **Automations**, choose the trigger *When a record matches conditions* on Colorways, add a *Run a script* action, and paste in the script. The comment at the top of the script lists the conditions and the `recordId` input variable.

**Check:** take a colorway that isn't ready yet, mark its remaining compliance tests *Passed*, and run LS-06. The colorway now matches the conditions, so the automation fires and it becomes *Synced* within seconds. Setting Sync Status to *Pending* by hand won't trigger the automation, because the record already matched before. The trigger only fires when a record *starts* matching.
