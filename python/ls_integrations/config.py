"""Settings loaded from environment / .env (repo root). Secrets never live in code."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env")  # does not override variables already set (e.g. by docker compose)


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass(frozen=True)
class Settings:
    erpnext_base_url: str
    erpnext_admin_user: str
    erpnext_admin_password: str
    erpnext_api_key: str
    erpnext_api_secret: str
    airtable_pat: str
    airtable_base_id: str
    webhook_token: str
    warehouse_dsn: str

    def require(self, *fields: str) -> None:
        missing = [f for f in fields if not getattr(self, f)]
        if missing:
            raise SystemExit(f"Missing settings: {', '.join(f.upper() for f in missing)} — set them in .env")


def load_settings() -> Settings:
    return Settings(
        erpnext_base_url=_env("ERPNEXT_BASE_URL", "http://localhost:8080").rstrip("/"),
        erpnext_admin_user=_env("ERPNEXT_ADMIN_USER", "Administrator"),
        erpnext_admin_password=_env("ERPNEXT_ADMIN_PASSWORD", "admin"),
        erpnext_api_key=_env("ERPNEXT_API_KEY"),
        erpnext_api_secret=_env("ERPNEXT_API_SECRET"),
        airtable_pat=_env("AIRTABLE_PAT"),
        airtable_base_id=_env("AIRTABLE_BASE_ID"),
        webhook_token=_env("LS_WEBHOOK_TOKEN"),
        warehouse_dsn=(
            f"host={_env('WAREHOUSE_HOST', 'localhost')} port={_env('WAREHOUSE_PORT', '5433')} "
            f"dbname={_env('WAREHOUSE_DB', 'ls_warehouse')} user={_env('WAREHOUSE_USER', 'ls_admin')} "
            f"password={_env('WAREHOUSE_PASSWORD', 'ls_admin_pw')}"
        ),
    )
