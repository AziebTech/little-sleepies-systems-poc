import json

import requests

from ls_integrations.erpnext import parse_error


def response(status: int, body) -> requests.Response:
    r = requests.Response()
    r.status_code = status
    r._content = json.dumps(body).encode() if not isinstance(body, bytes) else body
    return r


def test_duplicate_entry_extracts_server_message_and_hint():
    body = {
        "exc_type": "DuplicateEntryError",
        "_server_messages": json.dumps([json.dumps({"message": "Item <b>S-0108-0901-10</b> already exists"})]),
    }
    err = parse_error(response(409, body))
    assert err.status == 409
    assert err.exc_type == "DuplicateEntryError"
    assert "Item S-0108-0901-10 already exists" in str(err)  # HTML stripped
    assert "Duplicate" in str(err)


def test_falls_back_to_last_exception_line():
    body = {"exc_type": "LinkValidationError", "exception": "Traceback...\nLinkValidationError: Could not find Item Group: Outerwear"}
    err = parse_error(response(417, body))
    assert "Could not find Item Group: Outerwear" in str(err)
    assert "Validation failed" in str(err)


def test_non_json_body():
    err = parse_error(response(502, b"<html>Bad Gateway</html>"))
    assert err.status == 502
    assert "Bad Gateway" in str(err)
