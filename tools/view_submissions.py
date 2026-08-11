# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""View FormSpeak submissions stored in the Cloudflare D1 database.

Reads via the already-authenticated `wrangler` CLI — no API token needed
(shared plumbing in d1.py; the database name comes from wrangler.jsonc).

    uv run tools/view_submissions.py                 # latest 20
    uv run tools/view_submissions.py --limit 100      # more rows
    uv run tools/view_submissions.py --feedback         # only rows that left feedback
    uv run tools/view_submissions.py --json            # raw JSON for piping

The browser never touches this; it's a local admin view of demo data.
"""
import argparse
import json
import sys

import d1

COLS = [
    "id", "created_at", "first_name", "last_name", "address",
    "date_of_birth", "household_size", "household_income", "feedback",
]


def query(sql: str) -> list[dict]:
    """Run a read-only SQL statement against the remote D1 and return rows."""
    try:
        return d1.query_one(sql)
    except RuntimeError as e:
        sys.exit(f"wrangler failed:\n{e}")


def main() -> None:
    ap = argparse.ArgumentParser(description="View FormSpeak D1 submissions.")
    ap.add_argument("--limit", type=int, default=20, help="max rows (default 20)")
    ap.add_argument("--feedback", action="store_true", help="only rows with feedback")
    ap.add_argument("--json", action="store_true", help="print raw JSON")
    args = ap.parse_args()

    where = "WHERE TRIM(feedback) <> ''" if args.feedback else ""
    rows = query(
        f"SELECT * FROM submissions {where} ORDER BY created_at DESC LIMIT {args.limit};"
    )

    if args.json:
        print(json.dumps(rows, indent=2))
        return

    if not rows:
        print("No submissions found.")
        return

    cols = [c for c in COLS if any(c in r for r in rows)]
    widths = {c: max(len(c), *(len(str(r.get(c, ""))) for r in rows)) for c in cols}
    line = "  ".join(c.ljust(widths[c]) for c in cols)
    print(line)
    print("  ".join("-" * widths[c] for c in cols))
    for r in rows:
        print("  ".join(str(r.get(c, "")).ljust(widths[c]) for c in cols))
    print(f"\n{len(rows)} row(s).")


if __name__ == "__main__":
    main()
