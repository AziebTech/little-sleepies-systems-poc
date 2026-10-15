# Little Sleepies Systems POC: Product Launch & Production Sync

A working, free-to-run proof of concept of a product-launch and order integration stack. **Airtable** (Production, Photography, Compliance) ↔ **n8n** ↔ **ERPNext** (standing in for **NetSuite**) ↔ **Shopify**. Every sync event lands in **Postgres** (standing in for **Snowflake**) for monitoring.

> Independent project: not affiliated with Little Sleepies, and uses no company data. All prints, styles and suppliers are fictional.

```
 Airtable Colorway ──ready──▶ n8n LS-01 ──validate, SKU, upsert──▶ ERPNext template + size variants
        ▲                         │                                    │
        │◀── Synced / Error ──────┘                                    │ PO submitted
        │                                                              ▼
        └◀── PO #, qty, delivery ── n8n LS-02 ◀── ERPNext webhook ── Purchase Order

 Shopify order ──signed webhook──▶ n8n LS-05 ──▶ ERPNext Sales Order      ERPNext item ──▶ LS-04 ──▶ Shopify draft product

 every attempt ──▶ Postgres audit.sync_audit_logs ──▶ SQL / dbt / LS-03 health check
```

## What's inside

| Area | What it demonstrates | Path |
|---|---|---|
| n8n workflows (7) | Webhook + safety-net poll, idempotent upsert, error outputs, rate-limit batching, error workflow (LS-00), health check (LS-03), Shopify products (LS-04) and HMAC-verified orders (LS-05), launch critical path (LS-06) | `n8n/workflows/` (generated from `n8n/src/`) |
| Tested logic | SKU rules, compliance gate, error categorization, Shopify HMAC: **149 JS + 42 Python tests** | `n8n/src/lib/`, `tests/js/`, `python/tests/` |
| Python tooling | ERPNext bootstrap, Airtable schema as code, PO simulator, drift reconciliation, Shopify setup, signed test orders | `python/` |
| Airtable | Seven linked tables modelled on the public storefront, automation script, data-quality audit | `airtable/` |
| SQL / Snowflake / dbt | Audit schema, 9 analytics queries, Snowflake equivalents, dbt models + tests | `sql/`, `dbt/` |

## Docs
| Doc | Use it for |
|---|---|
| [SETUP.md](docs/SETUP.md) | Building the stack from scratch, one checked step at a time |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Diagrams, field mappings, design decisions |
| [RUNBOOK.md](docs/RUNBOOK.md) | Operations, failure modes, incident response |
| [Systems map](systems-map/little_sleepies_systems_map.html) | Interactive map of the nine data flows: what breaks, what to check, who owns which data (download and open in a browser) |

## Commands
| | |
|---|---|
| `npm test` | JS tests, including a check that the workflow JSON is up to date |
| `npm run build` | Regenerate `n8n/workflows/*.json` from `n8n/src` |
| `npm run test:py` | Python tests (in the tools container) |
| `npm run n8n:import` | Import the n8n credentials (streamed from `.env`, never written to disk) and the workflows |

## Free-tier notes
- **ERPNext** is open source; self-hosting with Docker is free (`frappe/erpnext:v16.50.0`). **n8n** self-hosted is free for internal use (pinned to 2.39.6).
- **Airtable**'s free plan has low monthly quotas (records, automation runs), so the poll intervals are conservative.
- **Snowflake** has no permanent free tier. Postgres stands in, and `sql/snowflake/` shows the Snowflake SQL.
