"""Minimal Airtable Web API + Metadata API client.

Limits to design around:
  * 5 requests/second per base (429 + 30s penalty if exceeded) → client-side throttle.
  * 10 records per create/update request → batch.
  * List endpoints page at 100 records with an `offset` cursor.
  * Free-plan workspaces also have a monthly API-call cap, so prefer fewer, batched calls.
"""
from __future__ import annotations

import time
from typing import Iterable, Iterator
from urllib.parse import quote

import requests

from .http import build_session

API = "https://api.airtable.com/v0"


class AirtableError(RuntimeError):
    pass


def chunks(items: list, size: int) -> Iterator[list]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


class AirtableClient:
    def __init__(self, pat: str, base_id: str, session: requests.Session | None = None, min_interval: float = 0.21):
        self.base_id = base_id
        self.session = session or build_session()
        self.session.headers["Authorization"] = f"Bearer {pat}"
        self.min_interval = min_interval  # ~4.7 req/s, just under the 5 req/s limit
        self._last_call = 0.0

    def _request(self, method: str, url: str, **kwargs):
        wait = self.min_interval - (time.monotonic() - self._last_call)
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()
        resp = self.session.request(method, url, timeout=60, **kwargs)
        if resp.status_code >= 400:
            raise AirtableError(f"{method} {url} -> HTTP {resp.status_code}: {resp.text[:500]}")
        return resp.json()

    def _table_url(self, table: str) -> str:
        return f"{API}/{self.base_id}/{quote(table, safe='')}"

    # ------------------------------------------------------------------ records
    def list_records(self, table: str, formula: str | None = None, fields: Iterable[str] | None = None) -> list[dict]:
        params: list[tuple[str, str]] = [("pageSize", "100")]
        if formula:
            params.append(("filterByFormula", formula))
        for f in fields or []:
            params.append(("fields[]", f))
        records, offset = [], None
        while True:
            page = self._request("GET", self._table_url(table), params=params + ([("offset", offset)] if offset else []))
            records.extend(page.get("records", []))
            offset = page.get("offset")
            if not offset:
                return records

    def create_records(self, table: str, rows: list[dict], typecast: bool = True) -> list[dict]:
        created = []
        for batch in chunks(rows, 10):
            body = {"records": [{"fields": r} for r in batch], "typecast": typecast}
            created.extend(self._request("POST", self._table_url(table), json=body)["records"])
        return created

    def update_records(self, table: str, updates: list[dict], typecast: bool = True) -> list[dict]:
        """updates: [{"id": "rec...", "fields": {...}}, ...] — PATCH semantics (only listed fields change)."""
        updated = []
        for batch in chunks(updates, 10):
            body = {"records": batch, "typecast": typecast}
            updated.extend(self._request("PATCH", self._table_url(table), json=body)["records"])
        return updated

    def delete_records(self, table: str, record_ids: list[str]) -> int:
        deleted = 0
        for batch in chunks(record_ids, 10):
            self._request("DELETE", self._table_url(table), params=[("records[]", rid) for rid in batch])
            deleted += len(batch)
        return deleted

    # ------------------------------------------------------------------ metadata (schema as code)
    def get_tables(self) -> list[dict]:
        return self._request("GET", f"{API}/meta/bases/{self.base_id}/tables")["tables"]

    def create_table(self, name: str, fields: list[dict], description: str = "") -> dict:
        body = {"name": name, "description": description, "fields": fields}
        return self._request("POST", f"{API}/meta/bases/{self.base_id}/tables", json=body)

    def create_field(self, table_id: str, field: dict) -> dict:
        return self._request("POST", f"{API}/meta/bases/{self.base_id}/tables/{table_id}/fields", json=field)
