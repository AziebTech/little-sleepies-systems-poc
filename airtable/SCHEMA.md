# Airtable base: "LS Production POC"

> This base mirrors how Little Sleepies actually structures products, based on their public storefront. **Colorways** is the table every integration reads and writes: LS-01 (to the ERP), LS-02 (PO updates back), LS-06 (critical path).

## Product model v2 (`python/scripts/setup_product_model.py`)

**What the storefront shows** (public `littlesleepies.com/products.json`, Oct 2026):
- SKU = **DIVISION-STYLE-COLORWAY-SIZE**, e.g. `S-0108-0665-10` = Sleep · Zippy (0108) · colorway 0665 · Preemie.
- Divisions: **S** = Sleep (Lunaluxe®), **D** = Play (Soluxe®), **O** = Other (loveys, totes).
- The colorway number is **per style**: Turkey Dash is 0665 on the Zippy but 0276 on the two-piece set. The print is tied together by a `print_family:` tag, not by the SKU.
- Size codes depend on the division and are **not in size order** (3T = 08, 2T = 12; 0–3 months is 01 in Sleep but 34 in Play), hence a Sort Order column.
- Rules live in `shared/product_model.json`, which the JS (n8n) and Python code share.

```
Prints ──┐                    ┌── Samples           (Production)
         ├── Colorways ───────┼── Compliance Tests  (Compliance & Integrity)
Style ───┘   (style × print)  └── Photo Shots       (Photography)
Master ── Size Run ── Size Codes
```

| Table | One row per | Key fields | Owner |
|---|---|---|---|
| **Style Master** | garment pattern | Style Number (0108), Division, Product Type (Shopify `product_type`), Fabric, Fiber Content, Retail Price, **Compliance Profile**, Size Run (→ Size Codes) | Product |
| **Prints** | artwork | Slug (`print_family`), Print Category, Theme, License, Licensor Approval (+ date) | Product / Design |
| **Size Codes** | size per division | Size Label, Size Code, Sort Order, Age Group | reference |
| **Colorways** | style × print | Style, Print, Colorway Number, Production Status, Launch / Merch Date, Inventory Tier, Limited Edition, Purchase Limit, Cost; **LS-06 owns:** SKU Base, Sample / Compliance / Photo Status, Timeline Status, Next Milestone, Next Due Date, Days Late, Critical Path | Production |
| **Samples** | sample round | Round (Proto → Fit → **Pre-Production** → Top of Production), Status, dates | Production |
| **Compliance Tests** | test | Test Type, Lab, Status, dates, Report Link | Compliance & Integrity |
| **Photo Shots** | shot | Shot Type, Status, Shoot / Delivered Date, DAM Asset ID | Photography |

**Compliance profiles** (simplified for the POC; the real matrix belongs to Compliance & Integrity):

| Profile | Required tests |
|---|---|
| Children's Sleepwear | Lead (CPSIA), Phthalates (CPSIA), Snug-Fit Dimensions (16 CFR 1615/1616), Tracking Label, Children's Product Certificate |
| Children's Apparel | Lead (CPSIA), Flammability (16 CFR 1610), Tracking Label, Children's Product Certificate |
| Children's Accessory | Lead (CPSIA), Tracking Label, Children's Product Certificate |
| Adult Apparel | Flammability (16 CFR 1610) |

**Launch critical path** (LS-06, weekdays): milestones count back from the launch date. Pre-production sample approved T-90 (Production), licensor approval T-75 (Product, licensed prints only), compliance passed T-60, photography delivered T-30, synced to ERP T-21 (Systems). "At risk" = due within 7 days, or a blocking problem (failed test, rejected sample, data issue).

**Worth adding by hand** (field types the API can't create):
- Rollup on Colorways: `COUNTALL` of Compliance Tests where Status = Passed, beside the LS-06 status, to show the two approaches side by side.
- Interface **"Launch Calendar"**: a calendar on Launch Date, coloured by Timeline Status.
- Interface per team: Production (Samples awaiting decision), Compliance (tests Submitted > 10 days), Photography (shots Planned this week). Page-by-page build guide: [INTERFACES.md](INTERFACES.md).

---

## Fields the integrations own on Colorways

| Field | Written by | Meaning |
|---|---|---|
| SKU Base, Sample / Compliance / Photo Status, Timeline Status, Next Milestone, Next Due Date, Days Late, Critical Path | LS-06 (weekdays) | Computed from Samples, Compliance Tests and Photo Shots |
| Sync Status, ERP Item Code, Last Sync Error, Last Synced At | LS-01 | ERP style template sync. Set Sync Status to *Pending* by hand to retry |
| PO Number, PO Qty, PO Size Breakdown, Vendor, Expected Delivery, PO Status | LS-02 | From ERPNext Purchase Orders, rolled up from size lines |

**Field ownership matters.** Lock integration-owned fields in the team interfaces, or group them in a "System" section, so people don't hand-edit the integration's state. Two writers on one field means the field can't be trusted.

## Automations

| Automation | Trigger | Action |
|---|---|---|
| Notify n8n when ready for the ERP | Colorways record matches: Production Status = *Approved for Production* AND Compliance Status = *Passed* | Run script `scripts/automation_notify_n8n.js` (input `recordId`) |
| *(optional)* Alert Production on sync error | Colorways: Sync Status = Error | Send Slack/email with Last Sync Error |

## Scripts

- `scripts/automation_notify_n8n.js`: automation "Run a script" action (webhook to n8n LS-01).
- `scripts/data_quality_audit.js`: Scripting extension. Pre-launch audit of Colorways (colorway numbers, links, size runs, duplicate SKU bases), plus bulk retry of fixed records.

## Free-plan limits to design around (verify current numbers on airtable.com/pricing)

- The free plan caps **API calls per month** and **automation runs per month**. LS-01's safety-net poll runs every 6 hours for that reason, and LS-06 writes only changed fields. The webhook is the fast path. Run the poll by hand during demos.
- 5 requests/second per base. n8n batches 5 requests per 1.1 s, and the Python client throttles itself.
- Records per create/update request: **10** via the REST API, **50** via `updateRecordsAsync` in scripts.
