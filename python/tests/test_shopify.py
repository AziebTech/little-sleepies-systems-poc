import json

from ls_integrations.config import REPO_ROOT
from ls_integrations.shopify import sign_webhook, verify_webhook

CASE = json.loads((REPO_ROOT / "shared" / "shopify_webhook_case.json").read_text(encoding="utf-8"))
BODY = CASE["body"].encode("utf-8")


def test_python_signature_matches_shared_fixture():
    # Same fixture the JS verifier accepts → both implementations agree byte-for-byte.
    assert sign_webhook(BODY, CASE["secret"]) == CASE["signature"]


def test_verify_rejects_tampering_and_wrong_secret():
    assert verify_webhook(BODY, CASE["secret"], CASE["signature"])
    assert not verify_webhook(BODY.replace(b'"quantity":2', b'"quantity":20'), CASE["secret"], CASE["signature"])
    assert not verify_webhook(BODY, "wrong", CASE["signature"])
    assert not verify_webhook(BODY, CASE["secret"], None)


def test_reserialized_json_does_not_verify():
    reserialized = json.dumps(json.loads(BODY), separators=(",", ":")).encode()
    assert reserialized != BODY
    assert not verify_webhook(reserialized, CASE["secret"], CASE["signature"])
