"""Send a Shopify-style, correctly signed orders/create webhook to n8n (LS-05).

Works with or without a real Shopify store: it signs the payload exactly as Shopify does
(HMAC-SHA256 of the raw body with SHOPIFY_CLIENT_SECRET). Use it to exercise LS-05's
success and failure paths on demand.

  python scripts/send_test_order.py                          # 2 lines: the newest size-variant SKUs
  python scripts/send_test_order.py --sku S-0108-0901-10 --qty 3
  python scripts/send_test_order.py --unknown-sku            # → order ON HOLD + alert
  python scripts/send_test_order.py --no-sku-line            # gift-card style line → ON HOLD
  python scripts/send_test_order.py --bad-signature          # → rejected, never touches the ERP
  python scripts/send_test_order.py --repeat 2               # same order twice → second is a duplicate
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ls_integrations.config import load_settings  # noqa: E402
from ls_integrations.erpnext import ErpNextClient  # noqa: E402
from ls_integrations.shopify import sign_webhook  # noqa: E402

# Inside the tools container n8n is "n8n:5678"; from the host use --url http://localhost:5678/...
DEFAULT_URL = os.environ.get("N8N_INTERNAL_URL", "http://n8n:5678") + "/webhook/shopify-orders"


def newest_skus(n: int) -> list[str]:
    s = load_settings()
    erp = ErpNextClient(s.erpnext_base_url, s.erpnext_api_key, s.erpnext_api_secret)
    # Size variants only (S-0108-0901-10): style templates can't be sold.
    items = erp.get_list("Item", filters=[["variant_of", "is", "set"], ["disabled", "=", 0]],
                         fields=["name"], limit=n, order_by="creation desc")
    if not items:
        raise SystemExit("No size variants in the ERP yet. Let LS-01 sync a colorway first, or pass --sku.")
    return [i["name"] for i in items]


def build_order(skus: list[str], qty: int, no_sku_line: bool) -> dict:
    order_id = random.randint(10**17, 10**18 - 1)  # realistic size: beyond JS safe integers
    number = random.randint(1000, 9999)
    lines = [{"id": random.randint(10**12, 10**13), "sku": sku, "quantity": qty, "price": "34.00",
              "title": f"Test item {sku}"} for sku in skus]
    if no_sku_line:
        lines.append({"id": 1, "sku": "", "quantity": 1, "price": "25.00", "title": "Gift Card"})
    return {
        "id": order_id,
        "admin_graphql_api_id": f"gid://shopify/Order/{order_id}",
        "name": f"#T{number}",
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "currency": "USD",
        "test": True,
        "financial_status": "paid",
        "line_items": lines,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sku", action="append", help="SKU to order (repeatable). Default: 2 newest synced SKUs")
    ap.add_argument("--qty", type=int, default=2)
    ap.add_argument("--unknown-sku", action="store_true", help="add a SKU the ERP has never heard of")
    ap.add_argument("--no-sku-line", action="store_true", help="add a line with no SKU (gift card)")
    ap.add_argument("--bad-signature", action="store_true", help="sign with the wrong secret")
    ap.add_argument("--repeat", type=int, default=1, help="deliver the same webhook N times (Shopify retries)")
    ap.add_argument("--url", default=DEFAULT_URL)
    args = ap.parse_args()

    secret = os.environ.get("SHOPIFY_CLIENT_SECRET", "").strip()
    if not secret:
        raise SystemExit("SHOPIFY_CLIENT_SECRET is empty in .env (any placeholder works without a real store).")

    skus = args.sku or newest_skus(2)
    if args.unknown_sku:
        skus = skus + ["S-0108-9999-10"]
    order = build_order(skus, args.qty, args.no_sku_line)
    raw = json.dumps(order, separators=(",", ":")).encode()  # these exact bytes are signed and sent
    signature = sign_webhook(raw, "wrong-secret" if args.bad_signature else secret)
    webhook_id = str(uuid.uuid4())

    for attempt in range(1, args.repeat + 1):
        resp = requests.post(args.url, data=raw, timeout=30, headers={
            "Content-Type": "application/json",
            "X-Shopify-Topic": "orders/create",
            "X-Shopify-Hmac-Sha256": signature,
            "X-Shopify-Shop-Domain": os.environ.get("SHOPIFY_STORE_DOMAIN") or "test-store.myshopify.com",
            "X-Shopify-Webhook-Id": webhook_id,
            "X-Shopify-API-Version": os.environ.get("SHOPIFY_API_VERSION") or "2026-10",
        })
        print(f"[{attempt}/{args.repeat}] POST {args.url} → HTTP {resp.status_code}")
        if attempt < args.repeat:
            time.sleep(3)
    print(f"Order {order['name']} ({order['admin_graphql_api_id']}) with SKUs {', '.join(skus)}"
          f"{' + a no-SKU line' if args.no_sku_line else ''}{' [BAD SIGNATURE]' if args.bad_signature else ''}")
    print("Watch: n8n → Executions (LS-05) · ERPNext → Sales Order list · Adminer → audit.sync_audit_logs")


if __name__ == "__main__":
    main()
