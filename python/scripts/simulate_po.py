"""Create and submit a Purchase Order in ERPNext for synced Little Sleepies items.

Submitting fires the ERPNext Webhook → n8n LS-02 → Airtable delivery fields. Use it to
demo the reverse flow without clicking through the PO form.

Usage:
  python scripts/simulate_po.py [--supplier "Blue Harbor Apparel"] [--qty 250] [--lead-days 45] [--max-items 6]
"""
from __future__ import annotations

import argparse
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ls_integrations.config import load_settings  # noqa: E402
from ls_integrations.erpnext import ErpNextClient  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--supplier", default="Sunrise Textile Co.")
    ap.add_argument("--qty", type=int, default=250)
    ap.add_argument("--lead-days", type=int, default=45)
    ap.add_argument("--max-items", type=int, default=6, help="size variants to order")
    args = ap.parse_args()

    s = load_settings()
    erp = ErpNextClient.login(s.erpnext_base_url, s.erpnext_admin_user, s.erpnext_admin_password)

    company = erp.get_list("Company", fields=["name"], limit=1)[0]["name"]
    warehouses = erp.get_list("Warehouse", filters=[["company", "=", company], ["is_group", "=", 0]], fields=["name"])
    warehouse = next((w["name"] for w in warehouses if w["name"].startswith("Stores")), warehouses[0]["name"])
    # POs are placed per size variant; the cost lives on the style template.
    items = erp.get_list("Item", filters=[["variant_of", "is", "set"], ["disabled", "=", 0]],
                         fields=["name", "variant_of"], limit=args.max_items, order_by="creation desc")
    if not items:
        raise SystemExit("No size variants yet. Approve a colorway in Airtable and let LS-01 sync it first.")
    costs = {t["name"]: t.get("valuation_rate") for t in erp.get_list(
        "Item", filters=[["name", "in", sorted({i["variant_of"] for i in items})]], fields=["name", "valuation_rate"])}

    schedule = (date.today() + timedelta(days=args.lead_days)).isoformat()
    po = erp.insert({
        "doctype": "Purchase Order",
        "supplier": args.supplier,
        "company": company,
        "transaction_date": date.today().isoformat(),
        "schedule_date": schedule,
        "set_warehouse": warehouse,
        "items": [{"item_code": i["name"], "qty": args.qty, "rate": costs.get(i["variant_of"]) or 1,
                   "schedule_date": schedule, "warehouse": warehouse} for i in items],
    })
    # Submit as a second call: in ERPNext v16 inserting with docstatus=1 in one request leaves
    # status stuck at 'Draft'. Submitting fires the on_submit webhook → LS-02.
    po = erp.update("Purchase Order", po["name"], {"docstatus": 1})
    print(f"Submitted {po['name']} to {args.supplier}: {len(items)} lines x {args.qty}, delivery {schedule}")
    for i in items:
        print(f"  - {i['name']}")
    print("Watch: n8n → Executions (LS-02), then the Airtable PO fields.")


if __name__ == "__main__":
    main()
