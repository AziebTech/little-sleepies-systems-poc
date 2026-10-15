"""Reconcile Airtable Colorways against ERPNext style templates (and their size variants); report drift.

  python scripts/reconcile.py                     # print + CSV report in reports/
  python scripts/reconcile.py --write-warehouse   # also load findings into audit.reconciliation_findings
  python scripts/reconcile.py --fail-on-drift     # exit 1 if drift (for schedulers / CI)

Read-only against both systems: it reports, a human decides. Auto-"fixing" drift without
knowing which side is right is how integrations corrupt data.
"""
from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ls_integrations.airtable import AirtableClient  # noqa: E402
from ls_integrations.config import REPO_ROOT, load_settings  # noqa: E402
from ls_integrations.erpnext import ErpNextClient  # noqa: E402
from ls_integrations.reconcile import Finding, reconcile  # noqa: E402

AT_FIELDS = ["Colorway", "Style", "Colorway Number", "Production Status", "Compliance Status", "Sync Status",
             "ERP Item Code", "SKU Base", "Launch Date", "Cost Price"]
ERP_FIELDS = ["name", "item_group", "valuation_rate", "custom_airtable_record_id", "custom_launch_date",
              "custom_colorway_number", "custom_size_run"]


def write_csv(findings: list[Finding], run_at: datetime) -> Path:
    out_dir = REPO_ROOT / "reports"
    out_dir.mkdir(exist_ok=True)
    path = out_dir / f"drift_{run_at:%Y%m%dT%H%M%SZ}.csv"
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(Finding.__dataclass_fields__))
        writer.writeheader()
        writer.writerows(f.as_dict() for f in findings)
    return path


def write_warehouse(dsn: str, findings: list[Finding], run_at: datetime) -> None:
    import psycopg  # imported lazily so the report works without a DB driver

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO audit.reconciliation_findings
               (run_at, kind, airtable_record_id, sku, field, airtable_value, erp_value)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            [(run_at, f.kind, f.airtable_record_id, f.sku, f.field, f.airtable_value, f.erp_value) for f in findings],
        )
    print(f"Loaded {len(findings)} findings into audit.reconciliation_findings")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write-warehouse", action="store_true")
    ap.add_argument("--fail-on-drift", action="store_true")
    args = ap.parse_args()

    s = load_settings()
    s.require("airtable_pat", "airtable_base_id", "erpnext_api_key", "erpnext_api_secret")
    at = AirtableClient(s.airtable_pat, s.airtable_base_id)
    erp = ErpNextClient(s.erpnext_base_url, s.erpnext_api_key, s.erpnext_api_secret)

    run_at = datetime.now(timezone.utc)
    colorways = at.list_records("Colorways", fields=AT_FIELDS)
    styles = {r["id"]: r["fields"] for r in at.list_records("Style Master", fields=["Division"])}
    templates = erp.get_list("Item", filters=[["custom_airtable_record_id", "is", "set"], ["has_variants", "=", 1]],
                             fields=ERP_FIELDS)
    variant_counts = Counter(v["variant_of"] for v in erp.get_list(
        "Item", filters=[["variant_of", "in", [t["name"] for t in templates] or ["-"]]], fields=["variant_of"]))
    findings = reconcile(colorways, templates, variant_counts, styles)

    print(f"Compared {len(colorways)} Airtable colorways with {len(templates)} ERPNext style templates "
          f"({sum(variant_counts.values())} size variants)")
    if not findings:
        print("No drift. Systems agree.")
    else:
        for kind, n in Counter(f.kind for f in findings).most_common():
            print(f"  {kind:<18} {n}")
        for f in findings[:25]:
            print(f"  - [{f.kind}] {f.sku or f.airtable_record_id}: {f.field or ''} "
                  f"airtable={f.airtable_value!r} erp={f.erp_value!r}")
        print(f"Report: {write_csv(findings, run_at)}")
        if args.write_warehouse:
            write_warehouse(s.warehouse_dsn, findings, run_at)
    if findings and args.fail_on_drift:
        sys.exit(1)


if __name__ == "__main__":
    main()
