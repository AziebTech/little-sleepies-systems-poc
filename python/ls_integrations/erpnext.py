"""Minimal ERPNext / Frappe REST client.

Frappe REST cheat sheet (the NetSuite analogue is SuiteTalk REST / RESTlets):
  GET    /api/resource/{DocType}?filters=[...]&fields=[...]   list   (≈ saved search / SuiteQL)
  GET    /api/resource/{DocType}/{name}                       read
  POST   /api/resource/{DocType}                              create
  PUT    /api/resource/{DocType}/{name}                       update (partial)
  DELETE /api/resource/{DocType}/{name}                       delete
  POST   /api/method/{dotted.path}                            call a whitelisted server method (≈ RESTlet)
Auth: header "Authorization: token <api_key>:<api_secret>" (≈ NetSuite token-based auth), or session login.
"""
from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import quote

import requests

from .http import build_session

# Frappe maps exception classes to HTTP status codes — useful for triage.
STATUS_HINTS = {
    401: "Authentication failed: check API key/secret or rotate the integration user's keys",
    403: "Permission denied: the integration user's roles lack access to this DocType",
    404: "Document not found",
    409: "Duplicate: a document with this name already exists",
    417: "Validation failed: mandatory field, bad link (e.g. missing Item Group) or business rule",
}


class ErpNextError(RuntimeError):
    def __init__(self, status: int, message: str, exc_type: str | None = None):
        self.status, self.exc_type = status, exc_type
        super().__init__(f"HTTP {status}{f' {exc_type}' if exc_type else ''}: {message}")


def parse_error(resp: requests.Response) -> ErpNextError:
    """Extract the human message from a Frappe error response."""
    exc_type, message = None, resp.text[:500]
    try:
        body = resp.json()
        exc_type = body.get("exc_type")
        if body.get("_server_messages"):
            msgs = []
            for raw in json.loads(body["_server_messages"]):
                try:
                    msgs.append(json.loads(raw).get("message", raw))
                except (ValueError, AttributeError):
                    msgs.append(raw)
            message = re.sub(r"<[^>]+>", "", "; ".join(msgs))
        elif body.get("exception"):
            message = body["exception"].splitlines()[-1]
    except ValueError:
        pass
    hint = STATUS_HINTS.get(resp.status_code)
    return ErpNextError(resp.status_code, f"{message}{f' ({hint})' if hint else ''}", exc_type)


class ErpNextClient:
    def __init__(self, base_url: str, api_key: str = "", api_secret: str = "", session: requests.Session | None = None):
        self.base_url = base_url.rstrip("/")
        self.session = session or build_session()
        if api_key and api_secret:
            self.session.headers["Authorization"] = f"token {api_key}:{api_secret}"

    @classmethod
    def login(cls, base_url: str, user: str, password: str) -> "ErpNextClient":
        """Session (cookie) auth — used only for one-time bootstrap as Administrator."""
        client = cls(base_url)
        resp = client.session.post(f"{client.base_url}/api/method/login", json={"usr": user, "pwd": password}, timeout=30)
        if resp.status_code != 200:
            raise parse_error(resp)
        return client

    # ------------------------------------------------------------------ core
    def _request(self, method: str, path: str, **kwargs) -> Any:
        resp = self.session.request(method, f"{self.base_url}{path}", timeout=60, **kwargs)
        if resp.status_code >= 400:
            raise parse_error(resp)
        return resp.json() if resp.content else None

    @staticmethod
    def _doc_path(doctype: str, name: str | None = None) -> str:
        path = f"/api/resource/{quote(doctype)}"
        return f"{path}/{quote(name, safe='')}" if name else path

    # ------------------------------------------------------------------ CRUD
    def get_list(self, doctype: str, filters: list | dict | None = None, fields: list[str] | None = None,
                 limit: int = 0, order_by: str | None = None) -> list[dict]:
        params: dict[str, Any] = {"limit_page_length": limit}  # 0 = no limit
        if filters:
            params["filters"] = json.dumps(filters)
        params["fields"] = json.dumps(fields or ["name"])
        if order_by:
            params["order_by"] = order_by
        return self._request("GET", self._doc_path(doctype), params=params)["data"]

    def get_doc(self, doctype: str, name: str) -> dict | None:
        try:
            return self._request("GET", self._doc_path(doctype, name))["data"]
        except ErpNextError as e:
            if e.status == 404:
                return None
            raise

    def exists(self, doctype: str, name: str) -> bool:
        return self.get_doc(doctype, name) is not None

    def insert(self, doc: dict) -> dict:
        doctype = doc["doctype"]
        return self._request("POST", self._doc_path(doctype), json=doc)["data"]

    def update(self, doctype: str, name: str, values: dict) -> dict:
        return self._request("PUT", self._doc_path(doctype, name), json=values)["data"]

    def call(self, method: str, **kwargs) -> Any:
        return self._request("POST", f"/api/method/{method}", json=kwargs).get("message")

    def ensure(self, doc: dict, key: str = "name") -> tuple[dict, bool]:
        """Create `doc` unless a document with doc[key] already exists. Returns (doc, created)."""
        existing = self.get_doc(doc["doctype"], doc[key])
        if existing:
            return existing, False
        return self.insert(doc), True
