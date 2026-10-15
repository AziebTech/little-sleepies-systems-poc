"""Product model v2 — Python twin of the SKU rules in n8n/src/lib/product-model.js.

Real Little Sleepies structure: DIVISION-STYLE-COLORWAY[-SIZE], e.g. S-0108-0665-10.
Both implementations read shared/product_model.json and run shared/product_model_cases.json.
"""
from __future__ import annotations

import json
import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from functools import lru_cache

from .config import REPO_ROOT

SKU_PATTERN = re.compile(r"^([SDO])-(\d{4})-(\d{4})(?:-(\d{2}))?$")


@lru_cache(maxsize=1)
def model() -> dict:
    return json.loads((REPO_ROOT / "shared" / "product_model.json").read_text(encoding="utf-8"))


def division_by_code(code: str) -> str | None:
    return next((d for d, v in model()["divisions"].items() if v["code"] == code), None)


def build_sku_base(division: str | None, style_number, colorway_number) -> str | None:
    d = model()["divisions"].get(division or "")
    style, colorway = str(style_number or "").strip(), str(colorway_number or "").strip()
    if not d or not re.fullmatch(r"\d{4}", style) or not re.fullmatch(r"\d{4}", colorway):
        return None
    return f"{d['code']}-{style}-{colorway}"


def parse_sku(sku: str | None) -> dict | None:
    m = SKU_PATTERN.match(str(sku or "").strip())
    if not m:
        return None
    return {"divisionCode": m[1], "division": division_by_code(m[1]), "style": m[2], "colorway": m[3], "sizeCode": m[4]}


def size_run_skus(sku_base: str, size_labels: list[str]) -> tuple[list[dict], list[str]]:
    """Variant SKUs (sorted by size, not by code) and any labels with no code in this division."""
    parsed = parse_sku(sku_base)
    table = model()["sizeCodes"].get(parsed["divisionCode"], []) if parsed else []
    variants, unknown = [], []
    for label in size_labels:
        size = next((s for s in table if s["label"] == label), None)
        if size:
            variants.append({"size": label, "sku": f"{sku_base}-{size['code']}", "sort": size["sort"]})
        else:
            unknown.append(label)
    return sorted(variants, key=lambda v: v["sort"]), unknown


def required_tests(profile: str | None) -> list[str] | None:
    return model()["complianceProfiles"].get(profile or "")


def size_attribute_name(division: str) -> str:
    """ERPNext Item Attribute per division (same label, different code per division)."""
    return f"Size ({division})"


def parse_cost(raw) -> float | None:
    """Accepts 18.5, "18.50", "$1,204.99". Returns a 2-dp float, or None if not a positive amount."""
    if raw is None or isinstance(raw, bool):
        return None
    cleaned = re.sub(r"[$,\s]", "", str(raw))
    if not re.fullmatch(r"-?\d*\.?\d+", cleaned):
        return None
    try:
        value = Decimal(cleaned)
    except InvalidOperation:
        return None
    if value <= 0:
        return None
    return float(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
