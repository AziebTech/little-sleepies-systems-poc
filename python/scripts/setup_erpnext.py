"""Idempotent ERPNext bootstrap for the POC — run after completing the setup wizard.

Creates (only if missing):
  * Item Groups: Little Sleepies > Sleep, Play, Other (divisions; plus legacy Sleepwear, Playwear)
  * Item Attributes "Size (Sleep|Play|Other)" whose abbreviations are the real size codes, so
    variants are named S-0108-0901-10; Item Variant Settings so sizes inherit template fields
  * Brand "Little Sleepies", Supplier Group + two demo suppliers
  * Custom Fields on Item (Airtable record ID, style, print, fabric, launch/approval dates)
  * Role "LS Production User" with scoped permissions (via the Role Permission Manager API)
  * Integration user integration@littlesleepies.local + API key/secret
  * ERPNext Webhooks: Purchase Order on_submit / on_update_after_submit → n8n

NetSuite analogues: Item Groups ≈ item hierarchy/class, Custom Field ≈ custitem_ field,
Role + Custom DocPerm ≈ role permissions, integration user + token ≈ integration record + TBA,
Webhook ≈ User Event script afterSubmit calling N/https.

Usage:
  python scripts/setup_erpnext.py                 # from host (Python installed)
  docker compose --profile tools run --rm tools python scripts/setup_erpnext.py --write-env
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ls_integrations.config import REPO_ROOT, load_settings  # noqa: E402
from ls_integrations.erpnext import ErpNextClient, ErpNextError  # noqa: E402
from ls_integrations.product_model import model, size_attribute_name  # noqa: E402

INTEGRATION_USER = "integration@littlesleepies.local"
INTEGRATION_ROLES = ["Item Manager", "Purchase User", "Stock User", "Sales User"]
N8N = "http://n8n:5678/webhook"  # docker-network hostname
WEBHOOKS = [
    {"name": "LS Purchase Order Submitted to n8n", "doctype": "Purchase Order", "event": "on_submit",
     "url": f"{N8N}/erpnext-po"},
    {"name": "LS Purchase Order Updated to n8n", "doctype": "Purchase Order", "event": "on_update_after_submit",
     "url": f"{N8N}/erpnext-po"},
    # Only style TEMPLATES from the Airtable sync get a Shopify product (one per colorway, sizes
    # as variants). Without has_variants this would fire once per size variant.
    {"name": "LS Item Created to n8n", "doctype": "Item", "event": "after_insert",
     "url": f"{N8N}/erpnext-item", "condition": "doc.custom_airtable_record_id and doc.has_variants"},
]
SHOPIFY_CUSTOMER = "Shopify Web Orders"

SALES_ORDER_FIELDS = [
    dict(fieldname="custom_shopify_order_id", label="Shopify Order ID", fieldtype="Data", insert_after="customer",
         read_only=1, search_index=1, no_copy=1,
         description="External ID (Shopify order GID) owned by the LS-05 sync. Used for idempotency."),
    dict(fieldname="custom_shopify_order_name", label="Shopify Order #", fieldtype="Data",
         insert_after="custom_shopify_order_id", read_only=1, no_copy=1, in_standard_filter=1),
]

CUSTOM_FIELDS = [
    # Own tab right after Details (≈ a NetSuite custom subtab). In v16 `description` is the last
    # field of the Details tab, so anything inserted after it without a tab lands under Accounting.
    dict(fieldname="custom_ls_tab", label="Little Sleepies", fieldtype="Tab Break", insert_after="description"),
    dict(fieldname="custom_ls_section", label="Little Sleepies Production", fieldtype="Section Break",
         insert_after="custom_ls_tab", collapsible=0),
    dict(fieldname="custom_airtable_record_id", label="Airtable Record ID", fieldtype="Data",
         insert_after="custom_ls_section", read_only=1, search_index=1, no_copy=1,
         description="External ID owned by the Airtable → n8n sync. Do not edit by hand."),
    dict(fieldname="custom_style_id", label="Style ID", fieldtype="Data", insert_after="custom_airtable_record_id",
         in_standard_filter=1),
    dict(fieldname="custom_print_name", label="Print Name", fieldtype="Data", insert_after="custom_style_id"),
    dict(fieldname="custom_ls_col_break", label="", fieldtype="Column Break", insert_after="custom_print_name"),
    dict(fieldname="custom_fabric_type", label="Fabric Type", fieldtype="Select", options="\nLunaluxe\nSoluxe",
         insert_after="custom_ls_col_break", in_standard_filter=1, in_list_view=1),
    dict(fieldname="custom_launch_date", label="Launch Date", fieldtype="Date", insert_after="custom_fabric_type"),
    dict(fieldname="custom_production_approval_date", label="Production Approval Date", fieldtype="Datetime",
         insert_after="custom_launch_date", read_only=1),
    # Product model v2 (colorway templates). Mirrors the storefront's product data and tags.
    dict(fieldname="custom_ls_merch_section", label="Merchandising", fieldtype="Section Break",
         insert_after="custom_production_approval_date", collapsible=1),
    dict(fieldname="custom_colorway_number", label="Colorway Number", fieldtype="Data",
         insert_after="custom_ls_merch_section", in_standard_filter=1),
    dict(fieldname="custom_print_family", label="Print Family", fieldtype="Data", insert_after="custom_colorway_number",
         in_standard_filter=1, description="Shopify tag print_family:<slug>"),
    dict(fieldname="custom_print_category", label="Print Category", fieldtype="Data", insert_after="custom_print_family"),
    dict(fieldname="custom_product_type", label="Product Type", fieldtype="Data", insert_after="custom_print_category",
         in_standard_filter=1, description="Shopify product_type, e.g. Zippy, LS/P PJ Set"),
    dict(fieldname="custom_fiber_content", label="Fiber Content", fieldtype="Data", insert_after="custom_product_type"),
    dict(fieldname="custom_compliance_profile", label="Compliance Profile", fieldtype="Data",
         insert_after="custom_fiber_content"),
    dict(fieldname="custom_ls_merch_col", label="", fieldtype="Column Break", insert_after="custom_compliance_profile"),
    dict(fieldname="custom_merch_date", label="Merch Date", fieldtype="Date", insert_after="custom_ls_merch_col"),
    dict(fieldname="custom_inventory_tier", label="Inventory Tier", fieldtype="Int", insert_after="custom_merch_date"),
    dict(fieldname="custom_limited_edition", label="Limited Edition", fieldtype="Check", insert_after="custom_inventory_tier"),
    dict(fieldname="custom_purchase_limit", label="Purchase Limit (per size, per customer)", fieldtype="Int",
         insert_after="custom_limited_edition"),
    dict(fieldname="custom_retail_price", label="Retail Price", fieldtype="Currency", insert_after="custom_purchase_limit"),
    dict(fieldname="custom_size_run", label="Size Run", fieldtype="Small Text", insert_after="custom_retail_price",
         description="Sizes in order, pipe-separated. LS-04 builds the Shopify variants from this"),
]

# Fields a variant inherits from its template (ERPNext "Item Variant Settings"). Editing the
# template then propagates to every size, like a NetSuite matrix parent.
VARIANT_FIELDS = [f["fieldname"] for f in CUSTOM_FIELDS if f["fieldtype"] not in ("Tab Break", "Section Break", "Column Break")] + [
    "brand", "description", "is_purchase_item", "is_sales_item",
]

# Role "LS Production User": can maintain Items but not delete them; read-only on purchasing.
PRODUCTION_ROLE = "LS Production User"
PRODUCTION_PERMS = {
    "Item": ["read", "write", "create", "report", "export", "print"],
    "Purchase Order": ["read", "report", "print"],
    "Item Group": ["read"],
    "Supplier": ["read"],
}

SUPPLIERS = ["Sunrise Textile Co.", "Blue Harbor Apparel"]


def log(created: bool, what: str) -> None:
    print(f"  {'+ created ' if created else '= exists  '} {what}")


DEMO_COMPANY = {"doctype": "Company", "company_name": "Little Sleepies Demo", "abbr": "LSD",
                "default_currency": "USD", "country": "United States"}


def require_company(erp: ErpNextClient) -> dict:
    fields = ["name", "abbr", "default_currency"]
    companies = erp.get_list("Company", fields=fields, limit=1)
    if companies:
        return companies[0]
    # ERPNext v16's setup wizard can complete without creating a Company. Creating one
    # also builds its chart of accounts, cost center and default warehouses (Stores - LSD).
    settings = erp.get_doc("System Settings", "System Settings") or {}
    if not settings.get("setup_complete"):
        raise SystemExit(
            "The ERPNext setup wizard isn't finished. Open http://localhost:8080, log in as\n"
            "Administrator, complete the wizard (United States / USD), then re-run this script."
        )
    print(f"No Company found; creating '{DEMO_COMPANY['company_name']}' (this takes ~30 s)")
    erp.insert(DEMO_COMPANY)
    return erp.get_list("Company", fields=fields, limit=1)[0]


def setup_fiscal_years(erp: ErpNextClient) -> None:
    """Transactions (e.g. Purchase Orders) fail with FiscalYearError if no fiscal year covers
    their date (NetSuite analogue: accounting periods not set up / not open)."""
    print("Fiscal years")
    this_year = date.today().year
    for year in (this_year, this_year + 1):
        covering = erp.get_list("Fiscal Year", filters=[["year_start_date", "<=", f"{year}-06-30"],
                                                        ["year_end_date", ">=", f"{year}-06-30"]])
        if not covering:
            erp.insert({"doctype": "Fiscal Year", "year": str(year),
                        "year_start_date": f"{year}-01-01", "year_end_date": f"{year}-12-31"})
        log(not covering, f"Fiscal Year covering {year}")


def setup_masters(erp: ErpNextClient) -> None:
    print("Item groups, brand, suppliers")
    _, c = erp.ensure({"doctype": "Item Group", "name": "Little Sleepies", "item_group_name": "Little Sleepies",
                       "parent_item_group": "All Item Groups", "is_group": 1})
    log(c, "Item Group: Little Sleepies")
    # Divisions (product model v2) plus the legacy groups older items still use.
    for group in (*model()["divisions"], "Sleepwear", "Playwear"):
        _, c = erp.ensure({"doctype": "Item Group", "name": group, "item_group_name": group,
                           "parent_item_group": "Little Sleepies", "is_group": 0})
        log(c, f"Item Group: {group}")
    _, c = erp.ensure({"doctype": "Brand", "name": "Little Sleepies", "brand": "Little Sleepies"})
    log(c, "Brand: Little Sleepies")
    _, c = erp.ensure({"doctype": "Supplier Group", "name": "Apparel Manufacturers",
                       "supplier_group_name": "Apparel Manufacturers", "parent_supplier_group": "All Supplier Groups"})
    log(c, "Supplier Group: Apparel Manufacturers")
    for s in SUPPLIERS:
        _, c = erp.ensure({"doctype": "Supplier", "name": s, "supplier_name": s,
                           "supplier_group": "Apparel Manufacturers", "supplier_type": "Company"})
        log(c, f"Supplier: {s}")


def setup_size_attributes(erp: ErpNextClient) -> None:
    """One Item Attribute per division: the same label has different codes per division
    (0-3 months = 01 in Sleep, 34 in Play) and an attribute value can only have one abbreviation.
    The abbreviation IS the size code, so ERPNext names variants S-0108-0901-10."""
    print("Size attributes (variant naming)")
    for division, d in model()["divisions"].items():
        name = size_attribute_name(division)
        values = [{"attribute_value": s["label"], "abbr": s["code"]} for s in model()["sizeCodes"][d["code"]]]
        existing = erp.get_doc("Item Attribute", name)
        if not existing:
            erp.insert({"doctype": "Item Attribute", "name": name, "attribute_name": name, "item_attribute_values": values})
            log(True, f"Item Attribute: {name} ({len(values)} sizes)")
            continue
        have = {v["attribute_value"] for v in existing.get("item_attribute_values", [])}
        missing = [v for v in values if v["attribute_value"] not in have]
        if missing:
            erp.update("Item Attribute", name, {"item_attribute_values": existing["item_attribute_values"] + missing})
        log(False, f"Item Attribute: {name}" + (f" (+{len(missing)} sizes)" if missing else ""))


def setup_variant_settings(erp: ErpNextClient) -> None:
    print("Item Variant Settings (fields copied from template to sizes)")
    settings = erp.get_doc("Item Variant Settings", "Item Variant Settings") or {}
    have = {r["field_name"] for r in settings.get("fields", [])}
    missing = [f for f in VARIANT_FIELDS if f not in have]
    if missing:
        erp.update("Item Variant Settings", "Item Variant Settings",
                   {"fields": settings.get("fields", []) + [{"field_name": f} for f in missing]})
    log(bool(missing), f"{len(VARIANT_FIELDS)} inherited fields" + (f" (+{len(missing)})" if missing else ""))


def setup_custom_fields(erp: ErpNextClient) -> None:
    for dt, fields in (("Item", CUSTOM_FIELDS), ("Sales Order", SALES_ORDER_FIELDS)):
        print(f"Custom fields on {dt}")
        for f in fields:
            doc, c = erp.ensure({"doctype": "Custom Field", "name": f"{dt}-{f['fieldname']}", "dt": dt, **f})
            log(c, f"{dt}.{f['fieldname']} ({f['fieldtype']})")
            # ensure() never touches existing fields, so apply layout changes explicitly.
            moved = {k: f[k] for k in ("insert_after", "label") if k in f and doc.get(k) != f[k]}
            if not c and moved:
                erp.update("Custom Field", doc["name"], moved)
                print(f"  ~ updated {dt}.{f['fieldname']}: {moved}")


def setup_shopify_masters(erp: ErpNextClient) -> None:
    """One channel customer for all web orders: the usual connector setting when the ERP
    doesn't need individual consumers (and keeps customer PII out of the ERP)."""
    print("Shopify channel customer")
    _, c = erp.ensure({"doctype": "Customer Group", "name": "Shopify", "customer_group_name": "Shopify",
                       "parent_customer_group": "All Customer Groups", "is_group": 0})
    log(c, "Customer Group: Shopify")
    _, c = erp.ensure({"doctype": "Territory", "name": "Online", "territory_name": "Online",
                       "parent_territory": "All Territories", "is_group": 0})
    log(c, "Territory: Online")
    _, c = erp.ensure({"doctype": "Customer", "name": SHOPIFY_CUSTOMER, "customer_name": SHOPIFY_CUSTOMER,
                       "customer_type": "Company", "customer_group": "Shopify", "territory": "Online"})
    log(c, f"Customer: {SHOPIFY_CUSTOMER}")


def default_warehouse(erp: ErpNextClient, company: dict) -> str | None:
    rows = erp.get_list("Warehouse", filters=[["company", "=", company["name"]], ["is_group", "=", 0]], fields=["name"])
    names = [r["name"] for r in rows]
    return next((n for n in names if n.startswith("Stores")), names[0] if names else None)


def setup_role(erp: ErpNextClient) -> None:
    print(f"Role: {PRODUCTION_ROLE}")
    _, c = erp.ensure({"doctype": "Role", "name": PRODUCTION_ROLE, "role_name": PRODUCTION_ROLE, "desk_access": 1})
    log(c, f"Role: {PRODUCTION_ROLE}")
    pm = "frappe.core.page.permission_manager.permission_manager"
    for doctype, ptypes in PRODUCTION_PERMS.items():
        try:
            existing = erp.get_list("Custom DocPerm", filters=[["parent", "=", doctype], ["role", "=", PRODUCTION_ROLE],
                                                                ["permlevel", "=", 0]])
            if not existing:
                # add() first copies the DocType's standard perms into Custom DocPerm, so existing
                # roles keep their access. Inserting Custom DocPerm rows directly would silently
                # replace ALL standard permissions for the DocType.
                erp.call(f"{pm}.add", parent=doctype, role=PRODUCTION_ROLE, permlevel=0)
            for ptype in ptypes:
                erp.call(f"{pm}.update", doctype=doctype, role=PRODUCTION_ROLE, permlevel=0, ptype=ptype, value=1)
            log(not existing, f"Permissions on {doctype}: {', '.join(ptypes)}")
        except ErpNextError as e:
            print(f"  ! could not set permissions on {doctype} via API ({e}).\n"
                  f"    Do it by hand: Role Permissions Manager → {doctype} → Add a new rule → {PRODUCTION_ROLE}.")


def setup_integration_user(erp: ErpNextClient, rotate: bool) -> tuple[str, str] | None:
    print(f"Integration user: {INTEGRATION_USER}")
    user, c = erp.ensure({
        "doctype": "User", "name": INTEGRATION_USER, "email": INTEGRATION_USER,
        "first_name": "n8n Integration", "user_type": "System User", "send_welcome_email": 0, "enabled": 1,
        "roles": [{"role": r} for r in INTEGRATION_ROLES],
    })
    log(c, f"User with roles {', '.join(INTEGRATION_ROLES)}")
    if not c:
        # Re-runs add roles introduced later (e.g. Sales User for Shopify orders) without dropping any.
        have = {r["role"] for r in erp.get_doc("User", INTEGRATION_USER).get("roles", [])}
        missing = [r for r in INTEGRATION_ROLES if r not in have]
        if missing:
            erp.update("User", INTEGRATION_USER, {"roles": [{"role": r} for r in sorted(have | set(missing))]})
            print(f"  + added roles {', '.join(missing)}")
    if user.get("api_key") and not rotate:
        print("  = API key already exists (secret is only shown once). Use --rotate-keys to issue a new pair.")
        return None
    result = erp.call("frappe.core.doctype.user.user.generate_keys", user=INTEGRATION_USER) or {}
    api_key = result.get("api_key") or erp.get_doc("User", INTEGRATION_USER).get("api_key")
    api_secret = result["api_secret"]
    print("  + generated API key/secret" + (" (old secret is now invalid)" if rotate else ""))
    return api_key, api_secret


def setup_webhooks(erp: ErpNextClient, token: str) -> None:
    print("ERPNext webhooks → n8n")
    if not token:
        print("  ! LS_WEBHOOK_TOKEN is empty in .env; skipping webhook creation.")
        return
    payload = '{"doctype": "{{ doc.doctype }}", "name": "{{ doc.name }}", "modified": "{{ doc.modified }}"}'
    for w in WEBHOOKS:
        existing = erp.get_list("Webhook", filters=[["webhook_doctype", "=", w["doctype"]],
                                                    ["webhook_docevent", "=", w["event"]],
                                                    ["request_url", "=", w["url"]]])
        if not existing:
            erp.insert({
                # v16 names Webhooks by prompt, so the name must be supplied.
                "doctype": "Webhook", "name": w["name"],
                "webhook_doctype": w["doctype"], "webhook_docevent": w["event"], "condition": w.get("condition", ""),
                "request_url": w["url"], "request_method": "POST", "request_structure": "JSON",
                "webhook_json": payload, "enabled": 1,
                "webhook_headers": [{"key": "Content-Type", "value": "application/json"},
                                    {"key": "X-LS-Webhook-Token", "value": token}],
            })
        elif w.get("condition"):
            current = erp.get_doc("Webhook", existing[0]["name"]) or {}
            if (current.get("condition") or "") != w["condition"]:
                erp.update("Webhook", existing[0]["name"], {"condition": w["condition"]})
                print(f"  ~ updated condition on {existing[0]['name']}: {w['condition']}")
        log(not existing, f"Webhook: {w['doctype']} {w['event']} → {w['url']}")


def write_env(values: dict[str, str]) -> None:
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        print("  ! .env not found; add these by hand: " + ", ".join(values))
        return
    text = env_path.read_text(encoding="utf-8")
    for key, value in values.items():
        if re.search(rf"^{key}=.*$", text, flags=re.M):
            text = re.sub(rf"^{key}=.*$", lambda _m: f"{key}={value}", text, flags=re.M)
        else:
            text = text.rstrip("\n") + f"\n{key}={value}\n"
    env_path.write_text(text, encoding="utf-8")
    print(f"  + wrote {', '.join(values)} to .env")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rotate-keys", action="store_true", help="issue a new API key/secret for the integration user")
    ap.add_argument("--write-env", action="store_true", help="write generated keys into .env")
    args = ap.parse_args()

    s = load_settings()
    print(f"Connecting to {s.erpnext_base_url} as {s.erpnext_admin_user}")
    erp = ErpNextClient.login(s.erpnext_base_url, s.erpnext_admin_user, s.erpnext_admin_password)
    company = require_company(erp)
    print(f"Company: {company['name']} ({company['abbr']}, {company['default_currency']})\n")

    setup_fiscal_years(erp)
    setup_masters(erp)
    setup_custom_fields(erp)
    setup_size_attributes(erp)
    setup_variant_settings(erp)
    setup_shopify_masters(erp)
    setup_role(erp)
    keys = setup_integration_user(erp, args.rotate_keys)
    # Save the secret immediately: it is shown only once, so a later failure must not lose it.
    if keys:
        api_key, api_secret = keys
        if args.write_env:
            write_env({"ERPNEXT_API_KEY": api_key, "ERPNEXT_API_SECRET": api_secret})
        else:
            print("\nAdd to .env (shown once):")
            print(f"  ERPNEXT_API_KEY={api_key}\n  ERPNEXT_API_SECRET={api_secret}")
    setup_webhooks(erp, s.webhook_token)

    # Defaults LS-05 uses when creating Sales Orders.
    warehouse = default_warehouse(erp, company)
    print(f"Sales Order defaults: company={company['name']}, warehouse={warehouse}")
    if args.write_env:
        write_env({"ERPNEXT_COMPANY": company["name"], "ERPNEXT_DEFAULT_WAREHOUSE": warehouse or ""})
    print("\nDone. Next: python scripts/setup_product_model.py --seed, then `npm run n8n:import`.")


if __name__ == "__main__":
    main()
