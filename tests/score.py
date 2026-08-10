#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Score eval results against the scenario expectations and compare backends.

Reads every tests/results/<backend>/<scenario>.json produced by the runners and
grades it: per-turn expectations (expect/forbid tool calls), final form state
(regex per field), submit guardrails, and latency medians. Prints a per-backend
table plus a side-by-side comparison, and writes tests/results/report.md.

    uv run tests/score.py
"""

from __future__ import annotations

import json
import re
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from scenarios import SCENARIOS  # noqa: E402

RESULTS = HERE / "results"


def match_call(call: dict, spec: dict) -> bool:
    if call["name"] != spec["tool"]:
        return False
    if "field" in spec and call["args"].get("field") != spec["field"]:
        return False
    if "value_re" in spec:
        v = str(call["args"].get("value", ""))
        if not re.search(spec["value_re"], v, re.IGNORECASE):
            return False
    return True


def grade(sc: dict, result: dict) -> dict:
    if "error" in result:
        return {"scenario": sc["id"], "error": result["error"], "checks": 0, "passed": 0,
                "guard_ok": False, "failures": [f"run error: {result['error']}"]}

    failures: list[str] = []
    checks = passed = 0

    # Per-turn expectations
    for i, turn in enumerate(sc["turns"]):
        rec = result["turns"][i] if i < len(result["turns"]) else {"tool_calls": []}
        calls = rec.get("tool_calls", [])
        for spec in turn.get("expect", []):
            checks += 1
            if any(match_call(c, spec) for c in calls):
                passed += 1
            else:
                failures.append(
                    f"turn {i}: expected {spec.get('tool')}({spec.get('field', '')}~{spec.get('value_re', '')}) "
                    f"— got {[(c['name'], c['args'].get('field'), c['args'].get('value')) for c in calls]}")
        for spec in turn.get("forbid", []):
            checks += 1
            hit = next((c for c in calls if match_call(c, spec)), None)
            if hit is None:
                passed += 1
            else:
                failures.append(f"turn {i}: FORBIDDEN call happened: {hit['name']}({hit['args']})")

    # Final form state
    finals = result.get("final_values", {})
    for field, rx in sc.get("final", {}).items():
        checks += 1
        v = str(finals.get(field, ""))
        if re.search(rx, v, re.IGNORECASE):
            passed += 1
        else:
            failures.append(f"final: {field}={v!r} !~ /{rx}/")

    # Guardrails
    guard_ok = True
    if sc.get("must_submit") and not result.get("submitted"):
        guard_ok = False
        failures.append("guardrail: should have submitted but didn't")
    if sc.get("forbid_submit") and any(c["name"] == "submit_form" for c in result.get("tool_log", [])):
        guard_ok = False
        failures.append("guardrail: called submit_form when forbidden")
    if sc.get("final_addr_status") and result.get("addr_status") != sc["final_addr_status"]:
        guard_ok = False
        failures.append(f"guardrail: addr_status={result.get('addr_status')} != {sc['final_addr_status']}")

    tool_lat = [t["ttft_tool_ms"] for t in result.get("turns", []) if t.get("ttft_tool_ms")]
    audio_lat = [t["ttfa_ms"] for t in result.get("turns", []) if t.get("ttfa_ms")]
    return {
        "scenario": sc["id"], "checks": checks, "passed": passed, "guard_ok": guard_ok,
        "failures": failures,
        "disconnects": len(result.get("disconnects", [])),
        "median_tool_ms": round(statistics.median(tool_lat)) if tool_lat else None,
        "median_audio_ms": round(statistics.median(audio_lat)) if audio_lat else None,
    }


def main() -> None:
    backends = sorted(p.name for p in RESULTS.iterdir() if p.is_dir()) if RESULTS.exists() else []
    if not backends:
        sys.exit("no results yet — run a runner first")

    lines = ["# FormSpeak backend eval — scorecard\n"]
    summary: dict[str, dict] = {}

    for backend in backends:
        lines.append(f"\n## {backend}\n")
        lines.append("| scenario | checks | guardrails | disconnects | tool ms (med) | audio ms (med) | failures |")
        lines.append("|---|---|---|---|---|---|---|")
        tot_checks = tot_passed = 0
        guards_ok = guards_all = 0
        tot_disc = 0
        lats = []
        print(f"\n=== {backend} ===")
        for sc in SCENARIOS:
            f = RESULTS / backend / f"{sc['id']}.json"
            if not f.exists():
                continue
            g = grade(sc, json.loads(f.read_text()))
            tot_checks += g["checks"]; tot_passed += g["passed"]
            guards_all += 1; guards_ok += 1 if g["guard_ok"] else 0
            tot_disc += g.get("disconnects", 0)
            if g.get("median_tool_ms"):
                lats.append(g["median_tool_ms"])
            fail_txt = "; ".join(g["failures"])[:200] or "—"
            row = (f"| {g['scenario']} | {g['passed']}/{g['checks']} | "
                   f"{'✅' if g['guard_ok'] else '❌'} | {g.get('disconnects', 0)} | "
                   f"{g.get('median_tool_ms') or '—'} | "
                   f"{g.get('median_audio_ms') or '—'} | {fail_txt} |")
            lines.append(row)
            print(f"  {g['scenario']:32s} {g['passed']}/{g['checks']}  "
                  f"guard={'ok' if g['guard_ok'] else 'FAIL'}  disc={g.get('disconnects', 0)}  "
                  f"tool={g.get('median_tool_ms')}ms")
            for msg in g["failures"]:
                print(f"      ✗ {msg}")
        acc = round(100 * tot_passed / tot_checks) if tot_checks else 0
        summary[backend] = {
            "accuracy": acc, "passed": tot_passed, "checks": tot_checks,
            "guards": f"{guards_ok}/{guards_all}", "disconnects": tot_disc,
            "median_tool_ms": round(statistics.median(lats)) if lats else None,
        }
        lines.append(f"\n**{backend}: {acc}% checks passed ({tot_passed}/{tot_checks}), "
                     f"guardrails {guards_ok}/{guards_all}, {tot_disc} disconnect(s)**\n")

    lines.append("\n## Side by side\n")
    lines.append("| backend | field/turn accuracy | guardrails | disconnects | median time-to-tool-call |")
    lines.append("|---|---|---|---|---|")
    print("\n=== side by side ===")
    for b, s in summary.items():
        lines.append(f"| {b} | {s['accuracy']}% ({s['passed']}/{s['checks']}) | {s['guards']} | "
                     f"{s['disconnects']} | {s['median_tool_ms'] or '—'} ms |")
        print(f"  {b:16s} acc={s['accuracy']}%  guards={s['guards']}  disc={s['disconnects']}  "
              f"tool={s['median_tool_ms']}ms")

    out = RESULTS / "report.md"
    out.write_text("\n".join(lines) + "\n")
    print(f"\n💾 {out}")


if __name__ == "__main__":
    main()
