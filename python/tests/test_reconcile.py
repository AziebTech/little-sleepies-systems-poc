from ls_integrations.reconcile import reconcile

STYLES = {"recST": {"Division": "Sleep"}}


def cw(rec_id, **fields):
    base = {
        "Production Status": "Approved for Production",
        "Compliance Status": "Passed",
        "Sync Status": "Synced",
        "ERP Item Code": "S-0108-0901",
        "SKU Base": "S-0108-0901",
        "Style": ["recST"],
        "Colorway Number": "0901",
        "Launch Date": "2027-01-16",
        "Cost Price": 9.8,
    }
    return {"id": rec_id, "fields": {**base, **fields}}


def tpl(rec_id, **fields):
    base = {"name": "S-0108-0901", "item_group": "Sleep", "valuation_rate": 9.8, "custom_airtable_record_id": rec_id,
            "custom_launch_date": "2027-01-16", "custom_colorway_number": "0901", "custom_size_run": "Preemie|Newborn|3T"}
    return {**base, **fields}


def run(colorways, templates, variants=None):
    counts = variants if variants is not None else {"S-0108-0901": 3}
    return sorted((f.kind, f.field) for f in reconcile(colorways, templates, counts, STYLES))


def test_in_sync_has_no_findings():
    assert run([cw("rec1")], [tpl("rec1")]) == []


def test_missing_in_erp_unless_it_failed_validation():
    assert run([cw("rec1", **{"Sync Status": "Pending"})], []) == [("missing_in_erp", "Sync Status")]
    assert run([cw("rec1", **{"Sync Status": "Error"})], []) == []


def test_colorways_not_ready_for_the_erp_are_ignored():
    assert run([cw("rec1", **{"Compliance Status": "In Testing"})], []) == []
    assert run([cw("rec1", **{"Production Status": "In Development"})], []) == []


def test_field_drift_is_reported_per_field():
    findings = run([cw("rec1")], [tpl("rec1", item_group="Play", valuation_rate=10.5, custom_launch_date="2027-02-01")])
    assert findings == [("field_mismatch", "Cost Price"), ("field_mismatch", "Division"), ("field_mismatch", "Launch Date")]


def test_cost_within_half_a_cent_is_not_drift():
    assert run([cw("rec1")], [tpl("rec1", valuation_rate=9.804)]) == []


def test_missing_size_variants_are_reported():
    # size run has 3 sizes but only 2 variants exist (size added later, or the background job failed)
    assert run([cw("rec1")], [tpl("rec1")], {"S-0108-0901": 2}) == [("variants_missing", "Size variants")]


def test_writeback_missing_when_erp_has_template_but_airtable_not_updated():
    assert run([cw("rec1", **{"Sync Status": "Pending", "ERP Item Code": None})], [tpl("rec1")]) == [
        ("writeback_missing", "ERP Item Code")]


def test_orphan_in_erp():
    findings = reconcile([], [tpl("recGONE")], {}, STYLES)
    assert [(f.kind, f.airtable_record_id) for f in findings] == [("orphan_in_erp", "recGONE")]
