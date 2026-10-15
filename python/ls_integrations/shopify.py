"""Minimal Shopify Admin GraphQL client for a Dev Dashboard app.

Since 1 Jan 2026 new apps are created in the Dev Dashboard (no more admin-created custom
apps). For a store in the same organization, the app swaps its client ID + secret for an
access token via the client-credentials grant. Tokens last 24 h, so fetch one per run.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
from typing import Any

import requests

from .http import build_session

DEFAULT_API_VERSION = "2026-10"


class ShopifyError(RuntimeError):
    pass


def sign_webhook(body: bytes, secret: str) -> str:
    """X-Shopify-Hmac-Sha256 value: base64(HMAC-SHA256(raw body, app client secret))."""
    return base64.b64encode(hmac.new(secret.encode(), body, hashlib.sha256).digest()).decode()


def verify_webhook(body: bytes, secret: str, header: str | None) -> bool:
    return bool(header) and hmac.compare_digest(sign_webhook(body, secret), header.strip())


class ShopifyClient:
    def __init__(self, store_domain: str, client_id: str, client_secret: str,
                 api_version: str = DEFAULT_API_VERSION, session: requests.Session | None = None):
        domain = store_domain.strip().rstrip("/")
        self.base_url = domain if domain.startswith("http") else f"https://{domain}"
        self.client_id, self.client_secret, self.api_version = client_id, client_secret, api_version
        self.session = session or build_session()
        self._token: str | None = None

    def token(self) -> str:
        if not self._token:
            resp = self.session.post(
                f"{self.base_url}/admin/oauth/access_token",
                data={"grant_type": "client_credentials", "client_id": self.client_id,
                      "client_secret": self.client_secret},
                timeout=30,
            )
            if resp.status_code != 200:
                raise ShopifyError(
                    f"Token request failed (HTTP {resp.status_code}): {resp.text[:300]}\n"
                    "Check: app installed on this store, store in the same Dev Dashboard organization, "
                    "client ID/secret copied from the app's Settings."
                )
            self._token = resp.json()["access_token"]
        return self._token

    def graphql(self, query: str, variables: dict | None = None, mutation_key: str | None = None) -> dict:
        """Run a query; raise on transport errors, top-level `errors` AND mutation `userErrors`
        (GraphQL reports most failures with HTTP 200)."""
        resp = self.session.post(
            f"{self.base_url}/admin/api/{self.api_version}/graphql.json",
            json={"query": query, "variables": variables or {}},
            headers={"X-Shopify-Access-Token": self.token()},
            timeout=60,
        )
        if resp.status_code != 200:
            raise ShopifyError(f"GraphQL HTTP {resp.status_code}: {resp.text[:300]}")
        body: dict[str, Any] = resp.json()
        problems = [e.get("message", str(e)) for e in body.get("errors") or []]
        if mutation_key:
            payload = (body.get("data") or {}).get(mutation_key) or {}
            problems += [f"{'.'.join(u.get('field') or [])}: {u['message']}" for u in payload.get("userErrors") or []]
        if problems:
            raise ShopifyError("; ".join(problems))
        return body["data"]
