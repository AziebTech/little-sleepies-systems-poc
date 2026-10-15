"""Shared HTTP session with retry/backoff for SaaS APIs."""
from __future__ import annotations

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

RETRY_STATUSES = (429, 500, 502, 503, 504)


def build_session(retries: int = 4, backoff: float = 1.0) -> requests.Session:
    """Session that retries transient failures with exponential backoff and honours Retry-After.

    POST is deliberately NOT retried automatically: a create that timed out may have
    succeeded server-side, and blindly re-POSTing makes duplicates. Callers make creates
    idempotent instead (look up by external ID first, then create or update).
    """
    retry = Retry(
        total=retries,
        backoff_factor=backoff,
        status_forcelist=RETRY_STATUSES,
        allowed_methods=frozenset({"GET", "PUT", "PATCH", "DELETE", "HEAD"}),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    session = requests.Session()
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update({"Accept": "application/json"})
    return session
