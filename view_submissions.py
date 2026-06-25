# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""View FormSpeak submissions stored in the Cloudflare D1 database.

Reads via the already-authenticated `wrangler` CLI — no API token needed.

    uv run view_submissions.py                 # latest 20, SSN masked
    uv run view_submissions.py --limit 100      # more rows
    uv run view_submissions.py --show-ssn        # reveal full SSN (PII!)
    uv run view_submissions.py --feedback         # only rows that left feedback
    uv run view_submissions.py --json            # raw JSON for piping

The browser never touches this; it's a local admin view of demo data.
"""
import argparse
import json
import subprocess
import sys

DB = "ramble-form-hackathon"
COLS = [
    "id", "created_at", "first_name", "last_name", "address",
    "date_of_birth", "ssn", "household_size", "household_income", "feedback",
]


def query(sql: str) -> list[dict]:
    """Run a read-only SQL statement against the remote D1 and return rows."""
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit(f"wrangler failed:\n{out.stderr or out.stdout}")
    try:
        return json.loads(out.stdout)[0]["results"]
    except (json.JSONDecodeError, KeyError, IndexError):
        sys.exit(f"unexpected wrangler output:\n{out.stdout}")


def mask_ssn(v: str) -> str:
    digits = "".join(c for c in (v or "") if c.isdigit())
    return f"•••-••-{digits[-4:]}" if len(digits) >= 4 else (v or "")


def main() -> None:
    ap = argparse.ArgumentParser(description="View FormSpeak D1 submissions.")
    ap.add_argument("--limit", type=int, default=20, help="max rows (default 20)")
    ap.add_argument("--show-ssn", action="store_true", help="reveal full SSN (PII!)")
    ap.add_argument("--feedback", action="store_true", help="only rows with feedback")
    ap.add_argument("--json", action="store_true", help="print raw JSON")
    args = ap.parse_args()

    where = "WHERE TRIM(feedback) <> ''" if args.feedback else ""
    rows = query(
        f"SELECT * FROM submissions {where} ORDER BY created_at DESC LIMIT {args.limit};"
    )

    if not args.show_ssn:
        for r in rows:
            r["ssn"] = mask_ssn(r.get("ssn", ""))

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
    print(f"\n{len(rows)} row(s).", "SSN masked — use --show-ssn to reveal." if not args.show_ssn else "")


if __name__ == "__main__":
    main()
