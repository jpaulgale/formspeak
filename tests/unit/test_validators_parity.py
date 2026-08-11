"""The Python validator ports must give the same answers as the shipped JS.

Runs the shared fixture (tests/fixtures/validator-cases.json) against the ports
in tests/formspeak_env.py; tests/js/validators.test.js runs the identical cases
against public/js/validators.js. A case failing on one side but not the other
means the port has drifted from the app.

    uv run pytest
"""

import json
import sys
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TESTS_DIR))

from formspeak_env import (  # noqa: E402
    dob_info,
    hh_size_info,
    income_info,
    phone_info,
    split_unit,
    with_unit,
)

CASES = json.loads((TESTS_DIR / "fixtures" / "validator-cases.json").read_text())

CHECKED_KEYS = ("reason", "n", "year", "amt", "intl")


def check_info(actual: dict, expected: dict, label: str) -> None:
    assert actual["ok"] == expected["ok"], f"{label}: ok"
    for k in CHECKED_KEYS:
        if k in expected:
            assert actual.get(k) == expected[k], f"{label}: {k}"


def test_phone_info_matches_fixture():
    for c in CASES["phone"]:
        check_info(phone_info(c["input"]), c, repr(c["input"]))


def test_dob_info_matches_fixture():
    for c in CASES["dob"]:
        check_info(dob_info(c["input"]), c, repr(c["input"]))


def test_hh_size_info_matches_fixture():
    for c in CASES["household_size"]:
        check_info(hh_size_info(c["input"]), c, repr(c["input"]))


def test_income_info_matches_fixture():
    for c in CASES["income"]:
        check_info(income_info(c["input"]), c, repr(c["input"]))


def test_split_unit_matches_fixture():
    for c in CASES["split_unit"]:
        base, unit = split_unit(c["input"])
        assert base == c["base"], f"{c['input']}: base"
        assert unit == c["unit"], f"{c['input']}: unit"


def test_with_unit_matches_fixture():
    for c in CASES["with_unit"]:
        assert with_unit(c["full"], c["unit"]) == c["output"]
