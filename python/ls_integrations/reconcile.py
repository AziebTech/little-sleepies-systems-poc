"""Drift detection between Airtable Colorways (Production's view) and ERPNext style templates
and their size variants (Finance's view).

Event-driven syncs eventually miss something: a webhook drops, someone edits the ERP by hand,
a size is added to a style's size run, a background variant job fails. A periodic
reconciliation is the backstop that turns "I think it's in sync" into a report with evidence.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

from .product_model import parse_cost

READY = "Approved for Production"
COST_TOLERANCE = 0.005


@dataclass(frozen=True)
class Finding:
    kind: str                # missing_in_erp | orphan_in_erp | field_mismatch | writeback_missing | variants_missing
    airtable_record_id: str | None
    sku: str | None
    field: str | None = None
    airtable_value: str | None = None
    erp_value: str | None = None

    def as_dict(self) -> dict:
        return asdict(self)


def reconcile(colorways: list[dict], templates: list[dict], variant_counts: dict[str, int],
              styles: dict[str, dict]) -> list[Finding]:
    """colorways: Airtable records ({id, fields}); templates: ERPNext Items with has_variants=1;
    variant_counts: template name → number of variants in the ERP; styles: Style Master record id → fields."""
    findings: list[Finding] = []
    erp_by_rec = {t["custom_airtable_record_id"]: t for t in templates if t.get("custom_airtable_record_id")}
    at_by_id = {r["id"]: r.get("fields", {}) for r in colorways}

    for rec_id, f in at_by_id.items():
        if f.get("Production Status") != READY or f.get("Compliance Status") != "Passed":
            continue  # not ready for the ERP yet: LS-06 reports those
        tpl = erp_by_rec.get(rec_id)
        if tpl is None:
            if f.get("Sync Status") != "Error":  # validation errors are expected not to be in the ERP
                findings.append(Finding("missing_in_erp", rec_id, f.get("SKU Base") or f.get("ERP Item Code"),
                                        "Sync Status", f.get("Sync Status"), None))
            continue

        sku = tpl["name"]
        if f.get("Sync Status") != "Synced" or f.get("ERP Item Code") != sku:
            findings.append(Finding("writeback_missing", rec_id, sku, "ERP Item Code", f.get("ERP Item Code"), sku))

        style = styles.get((f.get("Style") or [None])[0]) or {}
        comparisons = [
            ("Division", style.get("Division"), tpl.get("item_group")),
            ("Launch Date", f.get("Launch Date"), tpl.get("custom_launch_date")),
            ("Colorway Number", f.get("Colorway Number"), tpl.get("custom_colorway_number")),
        ]
        for field, at_val, erp_val in comparisons:
            if (at_val or None) != (erp_val or None):
                findings.append(Finding("field_mismatch", rec_id, sku, field, at_val, erp_val))

        at_cost, erp_cost = parse_cost(f.get("Cost Price")), tpl.get("valuation_rate")
        if at_cost is None or erp_cost is None or abs(at_cost - float(erp_cost)) > COST_TOLERANCE:
            findings.append(Finding("field_mismatch", rec_id, sku, "Cost Price",
                                    None if at_cost is None else f"{at_cost:.2f}",
                                    None if erp_cost is None else f"{float(erp_cost):.2f}"))

        # Size run vs variants: a size added in Airtable, or a background variant job that failed.
        expected = len([s for s in str(tpl.get("custom_size_run") or "").split("|") if s])
        actual = variant_counts.get(sku, 0)
        if expected and actual < expected:
            findings.append(Finding("variants_missing", rec_id, sku, "Size variants", str(expected), str(actual)))

    for rec_id, tpl in erp_by_rec.items():
        if rec_id not in at_by_id:
            findings.append(Finding("orphan_in_erp", rec_id, tpl["name"]))

    return findings
