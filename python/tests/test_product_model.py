import json

import pytest

from ls_integrations.config import REPO_ROOT
from ls_integrations.product_model import build_sku_base, parse_cost, parse_sku, required_tests, size_run_skus

CASES = json.loads((REPO_ROOT / "shared" / "product_model_cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("c", CASES["buildBase"], ids=lambda c: f"{c['division']}-{c['style']}-{c['colorway']}")
def test_build_sku_base(c):
    assert build_sku_base(c["division"], c["style"], c["colorway"]) == c["expected"]


@pytest.mark.parametrize("c", CASES["parse"], ids=lambda c: repr(c["sku"]))
def test_parse_sku(c):
    assert parse_sku(c["sku"]) == c["expected"]


@pytest.mark.parametrize("c", CASES["variants"], ids=lambda c: c["base"])
def test_size_run_skus(c):
    variants, unknown = size_run_skus(c["base"], c["sizes"])
    assert [v["sku"] for v in variants] == c["expected"]
    assert unknown == c["unknown"]


@pytest.mark.parametrize("c", CASES["cost"], ids=lambda c: repr(c["raw"]))
def test_parse_cost(c):
    assert parse_cost(c["raw"]) == c["expected"]


def test_every_profile_lists_tests():
    assert required_tests("Children's Sleepwear")[-1] == "Children's Product Certificate"
    assert required_tests("Nope") is None
