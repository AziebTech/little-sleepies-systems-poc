# Code node bodies by workflow

Each file is the body of one n8n Code node. `build-workflows.mjs` wires them into the workflows below.

| Workflow | Files |
|---|---|
| LS-00 Global Error Handler | `format-error-alert.js` |
| LS-01 Airtable Colorway → ERPNext: Style Template + Size Variants | `normalize-records.js`, `validate-transform.js`, `result-synced.js`, `result-erp-error.js`, `result-validation-failed.js` |
| LS-02 ERPNext PO → Airtable: Delivery Updates | `collect-po-names.js`, `explode-po-lines.js`, `result-po-synced.js`, `result-po-unmatched.js`, `result-po-line-error.js`, `result-po-fetch-error.js` |
| LS-03 Sync Pipeline Health Check | `evaluate-freshness.js` |
| LS-04 ERPNext Style → Shopify: Draft Product + Sizes | `build-shopify-product.js`, `result-product-created.js`, `result-product-exists.js`, `result-product-error.js` |
| LS-05 Shopify Order → ERPNext: Sales Order | `fetch-orders-to-reconcile.js`, `verify-normalize-order.js`, `match-order-skus.js`, `result-order-imported.js`, `result-order-duplicate.js`, `result-order-held.js`, `result-order-erp-error.js`, `result-order-rejected.js` |
| LS-06 Launch Critical Path | `compute-critical-path.js`, `batch-colorway-updates.js`, `milestone-snapshot.js`, `team-digest.js` |
