"""Check the Shopify app connection and register the orders/create webhook.

Prereqs (see docs/SETUP.md, step 8): a dev store and a Dev Dashboard app with scopes
read_orders, read_products, write_products, installed on that store. Put SHOPIFY_STORE_DOMAIN,
SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env.

  python scripts/setup_shopify.py                                   # connection check only
  python scripts/setup_shopify.py --webhook-base-url https://xxxx.trycloudflare.com
  python scripts/setup_shopify.py --backfill-products   # draft products for items synced before LS-04

Quick tunnels get a NEW URL each time they start, so re-run with --webhook-base-url after
restarting the tunnel: it replaces stale subscriptions instead of piling up dead ones
(Shopify deletes a subscription after 8 failed deliveries anyway).
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ls_integrations.config import load_settings  # noqa: E402  (importing it also loads .env)
from ls_integrations.erpnext import ErpNextClient  # noqa: E402
from ls_integrations.product_model import size_run_skus  # noqa: E402
from ls_integrations.shopify import DEFAULT_API_VERSION, ShopifyClient  # noqa: E402

WEBHOOK_PATH = "/webhook/shopify-orders"

SHOP_QUERY = "{ shop { name myshopifyDomain currencyCode plan { partnerDevelopment } } }"
LIST_HOOKS = """query { webhookSubscriptions(first: 50, topics: [ORDERS_CREATE]) { nodes { id uri } } }"""
CREATE_HOOK = """mutation create($uri: String!) {
  webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription: { uri: $uri }) {
    webhookSubscription { id uri } userErrors { field message } } }"""
DELETE_HOOK = """mutation del($id: ID!) { webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { field message } } }"""
FIND_VARIANT = "query findVariant($q: String!) { productVariants(first: 1, query: $q) { nodes { id } } }"
PRODUCT_SET = """mutation productSet($input: ProductSetInput!) {
  productSet(synchronous: true, input: $input) { product { id } userErrors { field message } } }"""


def slug(value) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")


def mmddyy(iso: str | None) -> str | None:
    return f"{iso[5:7]}{iso[8:10]}{iso[2:4]}" if iso else None


def backfill_products(shop: ShopifyClient) -> None:
    """Draft products (one per colorway, a variant per size) for style templates synced before
    LS-04 was switched on. Same mapping as LS-04 (n8n/src/lib/shopify.js buildProductSetRequest).
    Idempotent: skips colorways whose first size is already on Shopify."""
    s = load_settings()
    erp = ErpNextClient(s.erpnext_base_url, s.erpnext_api_key, s.erpnext_api_secret)
    templates = erp.get_list("Item", filters=[["custom_airtable_record_id", "is", "set"], ["has_variants", "=", 1],
                                              ["disabled", "=", 0]],
                             fields=["name", "item_name", "item_group", "description", "custom_size_run", "custom_retail_price",
                                     "custom_product_type", "custom_print_family", "custom_print_category",
                                     "custom_launch_date", "custom_merch_date", "custom_inventory_tier", "custom_limited_edition"])
    for t in templates:
        variants, unknown = size_run_skus(t["name"], [x for x in (t.get("custom_size_run") or "").split("|") if x])
        if not variants:
            print(f"! {t['name']}: no size run with known codes ({', '.join(unknown) or 'empty'}); skipped")
            continue
        if shop.graphql(FIND_VARIANT, {"q": f'sku:"{variants[0]["sku"]}"'})["productVariants"]["nodes"]:
            print(f"= {t['name']} already on Shopify")
            continue
        price = f"{float(t.get('custom_retail_price') or 0):.2f}"
        tags = [f"division:{slug(t['item_group'])}"]
        tags += [f"print_family:{t['custom_print_family']}"] if t.get("custom_print_family") else []
        tags += [f"print_category:{slug(t['custom_print_category'])}"] if t.get("custom_print_category") else []
        tags += [f"launch{mmddyy(t['custom_launch_date'])}"] if t.get("custom_launch_date") else []
        tags += [f"merch{mmddyy(t['custom_merch_date'])}"] if t.get("custom_merch_date") else []
        tags += [f"inventory_tier:{t['custom_inventory_tier']}"] if t.get("custom_inventory_tier") else []
        tags += ["tag_Limited Edition"] if t.get("custom_limited_edition") else []
        tags += ["erp-sync"] + (["needs-pricing"] if price == "0.00" else [])
        shop.graphql(PRODUCT_SET, {"input": {
            "title": t["item_name"], "status": "DRAFT", "vendor": "LSS Demo",
            "productType": t.get("custom_product_type") or t["item_group"],
            "descriptionHtml": f"<p>{t.get('description') or ''}</p>", "tags": tags,
            "productOptions": [{"name": "Size", "position": 1, "values": [{"name": v["size"]} for v in variants]}],
            "variants": [{"optionValues": [{"optionName": "Size", "name": v["size"]}], "price": price, "sku": v["sku"]}
                         for v in variants],
        }}, "productSet")
        print(f"+ {t['name']} → draft product with {len(variants)} sizes")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--webhook-base-url", help="public HTTPS base URL that reaches n8n (the tunnel URL)")
    ap.add_argument("--backfill-products", action="store_true", help="create draft products for already-synced ERP items")
    args = ap.parse_args()

    env = {k: os.environ.get(k, "").strip() for k in ("SHOPIFY_STORE_DOMAIN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET")}
    missing = [k for k, v in env.items() if not v]
    if missing:
        raise SystemExit(f"Missing in .env: {', '.join(missing)}")
    shop = ShopifyClient(env["SHOPIFY_STORE_DOMAIN"], env["SHOPIFY_CLIENT_ID"], env["SHOPIFY_CLIENT_SECRET"],
                         os.environ.get("SHOPIFY_API_VERSION") or DEFAULT_API_VERSION)

    info = shop.graphql(SHOP_QUERY)["shop"]
    print(f"Connected: {info['name']} ({info['myshopifyDomain']}, {info['currencyCode']}, "
          f"dev store: {info['plan']['partnerDevelopment']}) via API {shop.api_version}")

    if args.backfill_products:
        backfill_products(shop)
    if not args.webhook_base_url:
        print("No --webhook-base-url given: skipping webhook registration.")
        return
    if not args.webhook_base_url.startswith("https://"):
        raise SystemExit("Shopify only delivers webhooks to https:// URLs (use the tunnel URL).")
    target = args.webhook_base_url.rstrip("/") + WEBHOOK_PATH

    existing = shop.graphql(LIST_HOOKS)["webhookSubscriptions"]["nodes"]
    for hook in existing:
        if hook["uri"] != target and hook["uri"].endswith(WEBHOOK_PATH):
            shop.graphql(DELETE_HOOK, {"id": hook["id"]}, "webhookSubscriptionDelete")
            print(f"- removed stale subscription → {hook['uri']}")
    if any(h["uri"] == target for h in existing):
        print(f"= orders/create already → {target}")
    else:
        created = shop.graphql(CREATE_HOOK, {"uri": target}, "webhookSubscriptionCreate")
        print(f"+ orders/create → {created['webhookSubscriptionCreate']['webhookSubscription']['uri']}")
    print("Place a test order in the store admin (or run scripts/send_test_order.py) and watch LS-05.")


if __name__ == "__main__":
    main()
