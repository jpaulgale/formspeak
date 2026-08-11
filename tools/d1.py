"""Shared D1 access for the local admin tools (dashboard, view_*).

Everything goes through the already-authenticated `wrangler` CLI — no API token
is ever needed or stored. The database name is read from wrangler.jsonc so the
deploy config stays the single source of truth (no name drift across scripts).
"""

import json
import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def database_name() -> str:
    """The D1 database name from wrangler.jsonc (jsonc: strip //-comment lines)."""
    text = (REPO_ROOT / "wrangler.jsonc").read_text()
    cfg = json.loads(re.sub(r"^\s*//.*$", "", text, flags=re.MULTILINE))
    return cfg["d1_databases"][0]["database_name"]


DB = database_name()


def sql_str(v: str) -> str:
    """Escape a Python string as a single-quoted SQLite string literal.

    (wrangler's --command path has no parameter binding, so literals it is —
    the production Pages Functions use the bound D1 API instead.)
    """
    return "'" + str(v).replace("'", "''") + "'"


def query(*sqls: str) -> list[list[dict]]:
    """Run one or more SQL statements against the remote D1, one result set each.

    Each remote `wrangler` call costs ~2s of Node startup + network, dwarfing the
    query itself — so batch every statement you need into ONE invocation
    (wrangler returns one result set per statement, in order).
    """
    try:
        out = subprocess.run(
            [
                "npx",
                "wrangler",
                "d1",
                "execute",
                DB,
                "--remote",
                "--json",
                "--command",
                " ".join(sqls),
            ],
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            "wrangler timed out after 60s. First run installs wrangler via npx (can be slow) "
            "and may block on an auth/login prompt — try `npx wrangler whoami` once in a terminal."
        ) from None
    if out.returncode != 0:
        raise RuntimeError(out.stderr or out.stdout)
    try:
        return [rs["results"] for rs in json.loads(out.stdout)]
    except (json.JSONDecodeError, KeyError, TypeError):
        raise RuntimeError(f"unexpected wrangler output:\n{out.stdout}") from None


def query_one(sql: str) -> list[dict]:
    """Run a single statement and return its rows."""
    return query(sql)[0]
