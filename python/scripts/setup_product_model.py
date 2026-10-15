"""Product model v2 in Airtable: Style Master, Prints, Size Codes, Colorways, Samples,
Compliance Tests, Photo Shots, created through the Metadata API (schema as code, with
linked-record fields) and optionally seeded.

Mirrors the real Little Sleepies structure seen on the storefront: a product is a
Style × Print (= colorway) sold in a size run, with SKUs DIVISION-STYLE-COLORWAY-SIZE.
A legacy "Styles" table, if present, is left untouched. Nothing uses it any more.

  python scripts/setup_product_model.py            # create / top up tables and fields
  python scripts/setup_product_model.py --seed     # + demo data (skips rows that already exist)
  python scripts/setup_product_model.py --reset --seed   # rebuild the demo data from scratch.
      # Only while ERPNext has no synced items: new record IDs orphan the existing ERP items.

Field types the API can't create (formula, rollup, lookup) are listed in airtable/SCHEMA.md as
optional manual additions; LS-06 writes the computed statuses into plain fields instead.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ls_integrations.airtable import AirtableClient  # noqa: E402
from ls_integrations.config import REPO_ROOT, load_settings  # noqa: E402
from ls_integrations.product_model import build_sku_base, model, required_tests  # noqa: E402

TEXT = {"type": "singleLineText"}
LONG = {"type": "multilineText"}
DATE = {"type": "date", "options": {"dateFormat": {"name": "iso"}}}
DATETIME = {"type": "dateTime", "options": {"dateFormat": {"name": "iso"}, "timeFormat": {"name": "24hour"}, "timeZone": "utc"}}
URL = {"type": "url"}
CHECK = {"type": "checkbox", "options": {"icon": "check", "color": "greenBright"}}


def select(*choices: str) -> dict:
    return {"type": "singleSelect", "options": {"choices": [{"name": c} for c in choices]}}


def multi(*choices: str) -> dict:
    return {"type": "multipleSelects", "options": {"choices": [{"name": c} for c in choices]}}


def number(precision: int = 0) -> dict:
    return {"type": "number", "options": {"precision": precision}}


def money() -> dict:
    return {"type": "currency", "options": {"precision": 2, "symbol": "$"}}


def link(table: str) -> dict:
    return {"type": "multipleRecordLinks", "_links_to": table}  # resolved to linkedTableId at creation


DIVISIONS = list(model()["divisions"])
PROFILES = list(model()["complianceProfiles"])
TEST_TYPES = sorted({t for tests in model()["complianceProfiles"].values() for t in tests})

# Order matters: linked tables must exist before the tables that link to them.
# The first field of each table is its primary field.
SCHEMA: list[tuple[str, str, list[tuple[str, dict, str]]]] = [
    ("Size Codes", "Size codes per division (observed on the storefront). Codes are NOT in size order: use Sort Order.", [
        ("Size Key", TEXT, "Division letter + code + label, e.g. S-10 Preemie"),
        ("Division", select(*DIVISIONS), ""),
        ("Size Label", TEXT, "As shown to customers"),
        ("Size Code", TEXT, "Last SKU segment"),
        ("Sort Order", number(), ""),
        ("Age Group", select("Baby", "Toddler", "Kid", "Adult", "One Size"), ""),
    ]),
    ("Style Master", "One row per garment pattern (style number). Owned by Product.", [
        ("Style Number", TEXT, "4 digits, second SKU segment (0108 = Zippy)"),
        ("Style Name", TEXT, ""),
        ("Division", select(*DIVISIONS), "Sleep = S, Play = D, Other = O"),
        ("Product Type", TEXT, "Shopify product_type, e.g. Zippy, LS/P PJ Set"),
        ("Fabric", select("Lunaluxe", "Soluxe", "Other"), "Sleep = Lunaluxe, Play = Soluxe"),
        ("Fiber Content", TEXT, ""),
        ("Retail Price", money(), ""),
        ("Compliance Profile", select(*PROFILES), "Decides which tests every colorway of this style needs"),
        ("Age Groups", multi("Baby", "Toddler", "Kid", "Adult"), ""),
        ("Size Run", link("Size Codes"), ""),
    ]),
    ("Prints", "One row per print (artwork). Owned by Product / Design.", [
        ("Print Name", TEXT, ""),
        ("Slug", TEXT, "print_family tag on Shopify, e.g. turkey-dash"),
        ("Print Category", select("Animals", "Florals", "Celestial", "Holiday", "Stripes & Solids", "Food", "Sports", "Licensed"), ""),
        ("Theme", TEXT, "Shop / collection, e.g. Fall Favorites"),
        ("License", select("None", "Licensed"), ""),
        ("Licensor", TEXT, ""),
        ("Licensor Approval", select("Not Required", "Submitted", "Approved", "Changes Requested"), ""),
        ("Licensor Approval Date", DATE, ""),
    ]),
    ("Colorways", "Style × print: the unit that is sampled, tested, photographed, approved and synced. Owned by Production.", [
        ("Colorway", TEXT, "Print + style name, e.g. Midnight Moons Zippy"),
        ("Style", link("Style Master"), ""),
        ("Print", link("Prints"), ""),
        ("Colorway Number", TEXT, "4 digits, third SKU segment. Unique per style, not per print"),
        ("Production Status", select("In Development", "Approved for Production", "Cancelled"), ""),
        ("Launch Date", DATE, "Drop date (Shopify tag launchMMDDYY)"),
        ("Merch Date", DATE, ""),
        ("Inventory Tier", number(), "Buy depth 1-6 (Shopify tag inventory_tier)"),
        ("Limited Edition", CHECK, ""),
        ("Purchase Limit", number(), "Per size, per customer (5 on limited drops)"),
        ("Cost Price", money(), "Landed unit cost"),
        ("Factory", TEXT, ""),
        ("SKU Base", TEXT, "Owned by LS-06: DIVISION-STYLE-COLORWAY"),
        ("Sample Status", select("Not Started", "In Progress", "Approved"), "Owned by LS-06"),
        ("Compliance Status", select("Not Started", "In Testing", "Passed", "Failed"), "Owned by LS-06"),
        ("Photo Status", select("Not Started", "In Progress", "Complete"), "Owned by LS-06"),
        ("Timeline Status", select("On Track", "At Risk", "Late", "Complete", "No Launch Date"), "Owned by LS-06"),
        ("Next Milestone", TEXT, "Owned by LS-06"),
        ("Next Due Date", DATE, "Owned by LS-06"),
        ("Days Late", number(), "Owned by LS-06"),
        ("Critical Path", LONG, "Owned by LS-06"),
        ("Sync Status", select("Not Synced", "Pending", "Synced", "Error"), "ERP sync (LS-01 after step 3)"),
        ("ERP Item Code", TEXT, "Owned by LS-01: the ERPNext style template (SKU base)"),
        ("Last Synced At", DATETIME, ""),
        ("Last Sync Error", LONG, "Owned by LS-01"),
        ("PO Number", TEXT, "Owned by LS-02 (latest ERPNext Purchase Order)"),
        ("PO Qty", number(), "Owned by LS-02: all sizes"),
        ("PO Size Breakdown", LONG, "Owned by LS-02, e.g. Preemie ×100, Newborn ×150"),
        ("Vendor", TEXT, "Owned by LS-02"),
        ("Expected Delivery", DATE, "Owned by LS-02"),
        ("PO Status", TEXT, "Owned by LS-02"),
    ]),
    ("Samples", "Sample rounds per colorway. Owned by Production.", [
        ("Sample", TEXT, ""),
        ("Colorway", link("Colorways"), ""),
        ("Round", select("Proto", "Fit", "Pre-Production", "Top of Production"), "PP approval gates production"),
        ("Status", select("Requested", "Received", "Approved", "Rejected"), ""),
        ("Requested Date", DATE, ""),
        ("Received Date", DATE, ""),
        ("Decision Date", DATE, ""),
        ("Comments", LONG, ""),
    ]),
    ("Compliance Tests", "Required tests per colorway (simplified). Owned by Compliance & Integrity.", [
        ("Test", TEXT, ""),
        ("Colorway", link("Colorways"), ""),
        ("Test Type", select(*TEST_TYPES), ""),
        ("Lab", TEXT, ""),
        ("Status", select("Not Started", "Submitted", "Passed", "Failed", "Not Applicable"), ""),
        ("Submitted Date", DATE, ""),
        ("Result Date", DATE, ""),
        ("Report Link", URL, ""),
    ]),
    ("Photo Shots", "Shot list per colorway. Owned by Photography.", [
        ("Shot", TEXT, ""),
        ("Colorway", link("Colorways"), ""),
        ("Shot Type", select("Flat Lay", "On-Model", "Lifestyle", "Family Matching", "Detail"), ""),
        ("Status", select("Planned", "Shot", "In Retouch", "Delivered"), ""),
        ("Shoot Date", DATE, ""),
        ("Delivered Date", DATE, ""),
        ("Model Size", TEXT, ""),
        ("DAM Asset ID", TEXT, "ID in the digital asset management system"),
    ]),
]


def field_def(name: str, spec: dict, desc: str, table_ids: dict[str, str]) -> dict:
    spec = dict(spec)
    if "_links_to" in spec:
        spec = {"type": "multipleRecordLinks", "options": {"linkedTableId": table_ids[spec.pop("_links_to")]}}
    return {"name": name, **spec, **({"description": desc} if desc else {})}


def ensure_schema(at: AirtableClient) -> dict[str, str]:
    tables = {t["name"]: t for t in at.get_tables()}
    ids = {name: t["id"] for name, t in tables.items()}
    for name, description, fields in SCHEMA:
        if name not in tables:
            created = at.create_table(name, [field_def(*f, ids) for f in fields], description)
            ids[name] = created["id"]
            print(f"+ table {name} ({len(fields)} fields)")
            continue
        have = {f["name"] for f in tables[name]["fields"]}
        added = [f for f in fields if f[0] not in have]
        for f in added:
            at.create_field(ids[name], field_def(*f, ids))
        print(f"= table {name} exists" + (f" (+{len(added)} fields)" if added else ""))
    return ids


# ---------------------------------------------------------------- seed
def seed(at: AirtableClient) -> None:
    spec = json.loads((REPO_ROOT / "airtable" / "seed_product_model.json").read_text(encoding="utf-8"))
    today = date.today()
    d = lambda n: (today + timedelta(days=n)).isoformat()  # noqa: E731
    # A completed event on the launch calendar, or N days ago if that date is still in the future.
    # Fallbacks keep the real order of events (proto → fit → PP → tests → photos → sync).
    past = lambda iso, ago=1: min(iso, d(-ago))  # noqa: E731

    def existing(table: str, primary: str) -> dict[str, str]:
        return {r["fields"].get(primary): r["id"] for r in at.list_records(table, fields=[primary])}

    def create(table: str, primary: str, rows: list[dict]) -> dict[str, str]:
        have = existing(table, primary)
        new = [{k: v for k, v in r.items() if v is not None and v != ""} for r in rows if r[primary] not in have]
        for rec in at.create_records(table, new) if new else []:
            have[rec["fields"][primary]] = rec["id"]
        print(f"+ {table}: {len(new)} seeded ({len(rows) - len(new)} already present)")
        return have

    # Size codes (all observed) and styles linked to their size runs
    sizes = []
    for div_name, div in model()["divisions"].items():
        for s in model()["sizeCodes"][div["code"]]:
            sizes.append({"Size Key": f"{div['code']}-{s['code']} {s['label']}", "Division": div_name, "Size Label": s["label"],
                          "Size Code": s["code"], "Sort Order": s["sort"], "Age Group": s["ageGroup"]})
    size_ids = create("Size Codes", "Size Key", sizes)
    size_id = {(row["Division"], row["Size Label"]): size_ids[row["Size Key"]] for row in sizes}

    style_rows = [{
        "Style Number": s["number"], "Style Name": s["name"], "Division": s["division"], "Product Type": s["productType"],
        "Fabric": s["fabric"], "Fiber Content": s["fiber"], "Retail Price": s["retail"], "Compliance Profile": s["profile"],
        "Age Groups": s["ages"], "Size Run": [size_id[(s["division"], label)] for label in s["sizes"]],
    } for s in spec["styles"]]
    style_ids = create("Style Master", "Style Number", style_rows)
    styles = {s["number"]: s for s in spec["styles"]}

    print_rows = [{
        "Print Name": p["name"], "Slug": p["slug"], "Print Category": p["category"], "Theme": p["theme"],
        "License": p["license"], "Licensor": p.get("licensor", ""),
        "Licensor Approval": p.get("licensorApproval", "Not Required"),
    } for p in spec["prints"]]
    print_ids = create("Prints", "Print Name", print_rows)

    # Colorways + generated child records
    cw_rows, samples, tests, shots = [], [], [], []
    for c in spec["colorways"]:
        style = styles[c["style"]]
        name = f"{c['print']} {style['name']}"
        launch = d(c["launchInDays"])
        L = lambda n: (date.fromisoformat(launch) + timedelta(days=n)).isoformat()  # noqa: E731,B023
        st = c["state"]
        synced = st.get("synced", False)
        sku = build_sku_base(style["division"], style["number"], c["colorway"])
        cw_rows.append({
            "Colorway": name, "Style": [style_ids[c["style"]]], "Print": [print_ids[c["print"]]],
            "Colorway Number": c["colorway"], "Launch Date": launch, "Merch Date": launch,
            "Production Status": "Approved for Production" if st["sample"] == "approved" else "In Development",
            "Inventory Tier": c["tier"], "Limited Edition": c["limited"], "Purchase Limit": 5 if c["limited"] else None,
            "Cost Price": c["cost"], "Factory": "Example Apparel Co. (fictional)",
            "Sync Status": "Synced" if synced else "Not Synced",
            "ERP Item Code": sku if synced else "",
            "Last Synced At": datetime.combine(date.fromisoformat(past(L(-25), 5)), time(15), timezone.utc).isoformat() if synced else None,
        })

        if st["sample"] in ("approved", "pp_rejected", "proto"):
            samples.append({"Sample": f"{name}: Proto", "_cw": name, "Round": "Proto", "Status": "Received" if st["sample"] == "proto" else "Approved",
                            "Requested Date": past(L(-150), 75), "Received Date": past(L(-135), 68),
                            "Decision Date": None if st["sample"] == "proto" else past(L(-130), 65)})
        if st["sample"] in ("approved", "pp_rejected"):
            samples.append({"Sample": f"{name}: Fit", "_cw": name, "Round": "Fit", "Status": "Approved",
                            "Requested Date": past(L(-128), 60), "Received Date": past(L(-118), 52), "Decision Date": past(L(-115), 50)})
            rejected = st["sample"] == "pp_rejected"
            samples.append({"Sample": f"{name}: Pre-Production", "_cw": name, "Round": "Pre-Production",
                            "Status": "Rejected" if rejected else "Approved",
                            "Requested Date": past(L(-110), 45), "Received Date": past(L(-100), 40), "Decision Date": d(-3) if rejected else past(L(-95), 35),
                            "Comments": "Print scale too large on the 3XL; resubmit." if rejected else ""})

        required = required_tests(style["profile"]) or []
        for i, t in enumerate(required):
            mode = st["compliance"]
            if mode == "none":
                break
            if mode == "passed" or (mode == "failed_lead" and t != "Lead (CPSIA)") or (mode == "in_testing" and i < len(required) // 2):
                status, submitted, result = "Passed", past(L(-80), 30), past(L(-65), 20)
            elif mode == "failed_lead":
                status, submitted, result = "Failed", d(-14), d(-6)
            else:
                status, submitted, result = "Submitted", d(-7), None
            tests.append({"Test": f"{name}: {t}", "_cw": name, "Test Type": t, "Lab": "Example Testing Lab (fictional)",
                          "Status": status, "Submitted Date": submitted, "Result Date": result})

        shot_types = {"Children's Sleepwear": ["Flat Lay", "On-Model", "Family Matching"], "Adult Apparel": ["Flat Lay", "On-Model"],
                      "Children's Apparel": ["Flat Lay", "On-Model", "Lifestyle"], "Children's Accessory": ["Flat Lay", "Detail"]}[style["profile"]]
        for i, kind in enumerate(shot_types):
            mode = st["photo"]
            if mode == "none":
                break
            if mode == "delivered" or (mode == "partial" and i == 0):
                status, shoot, delivered = "Delivered", past(L(-45), 12), past(L(-35), 8) if mode == "delivered" else d(-4)
            elif mode == "partial":
                status, shoot, delivered = "In Retouch", d(-6), None
            else:
                status, shoot, delivered = "Planned", d(7), None
            shots.append({"Shot": f"{name}: {kind}", "_cw": name, "Shot Type": kind, "Status": status,
                          "Shoot Date": shoot, "Delivered Date": delivered})

    cw_ids = create("Colorways", "Colorway", cw_rows)
    for table, primary, rows in (("Samples", "Sample", samples), ("Compliance Tests", "Test", tests), ("Photo Shots", "Shot", shots)):
        for r in rows:
            r["Colorway"] = [cw_ids[r.pop("_cw")]]
        create(table, primary, rows)


def reset(at: AirtableClient) -> None:
    """Delete every record in the product-model tables, children first. Demo data only:
    the legacy Styles table is never touched."""
    for name, _, fields in reversed(SCHEMA):
        ids = [r["id"] for r in at.list_records(name, fields=[fields[0][0]])]
        print(f"- {name}: deleted {at.delete_records(name, ids)} records")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", action="store_true", help="insert demo data (idempotent: skips existing rows)")
    ap.add_argument("--reset", action="store_true",
                    help="DELETE all records in the 7 product-model tables first (never the legacy Styles table)")
    args = ap.parse_args()
    s = load_settings()
    s.require("airtable_pat", "airtable_base_id")
    at = AirtableClient(s.airtable_pat, s.airtable_base_id)
    ensure_schema(at)
    if args.reset:
        reset(at)
    if args.seed:
        seed(at)
    print("Next: run LS-06 (Launch Critical Path) to compute SKU bases and timeline statuses.")


if __name__ == "__main__":
    main()
