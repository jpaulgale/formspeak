"""Shared "virtual browser" for the FormSpeak model evals.

The real app (public/js/) owns three things the model's behavior depends
on: the system instruction (prompt.js), the tool declarations, and the
client-side tool RESPONSES (validation verdicts, geosearch outcomes — tools.js).
This module reproduces all three for headless harnesses so both backends under
test (Gemini Live baseline, LiveKit Gemma-4 candidate) see exactly what the
browser would send them.

- The system instruction is EXTRACTED from public/js/prompt.js at runtime (not
  copied), so the eval can never drift from the shipped prompt.
- Validators (phone/dob/household/income) and the tool-dispatch response
  strings are line-for-line ports of public/js/validators.js and tools.js —
  tests/fixtures/validator-cases.json holds shared cases both sides must pass.
- Address verification calls the same /api/geosearch endpoint the browser uses
  (serve.py must be running), so verdicts are byte-identical.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

HERE = Path(__file__).parent
PROMPT_JS = HERE.parent / "public" / "js" / "prompt.js"
SERVE_BASE = "http://localhost:8000"

FIELD_KEYS = [
    "first_name",
    "last_name",
    "address",
    "date_of_birth",
    "phone",
    "household_size",
    "household_income",
    "preferred_language",
]

# (key, label, question) — mirrors FIELDS in public/js/config.js; used by resume_context().
FIELD_META = [
    ("first_name", "First name", "What's your first name?"),
    ("last_name", "Last name", "And your last name?"),
    ("address", "Address (New York City)", "What's your home address in New York City?"),
    ("date_of_birth", "Date of birth", "What's your date of birth?"),
    ("phone", "Phone number", "What's your phone number?"),
    ("household_size", "Household size", "How many people are in your household?"),
    (
        "household_income",
        "Monthly household income",
        "About how much does your household earn each month, before taxes?",
    ),
    ("preferred_language", "Preferred language", "What language would you like to get notices in?"),
]

# Test sessions announce themselves with this prefix; log.js / serve.py set
# sessions.is_test=1 from it so analytics can exclude eval traffic.
TEST_SESSION_PREFIX = "test-"


def field_filled(form: VirtualForm, key: str) -> bool:
    """Port of isFilled(): value present AND its deterministic gate passes."""
    v = form.values.get(key)
    if not v:
        return False
    if key == "address":
        return form.addr_status == "ok"
    if key == "phone":
        return phone_info(v)["ok"]
    if key == "date_of_birth":
        return dob_info(v)["ok"]
    if key == "household_size":
        return hh_size_info(v)["ok"]
    if key == "household_income":
        return income_info(v)["ok"]
    return True


def resume_context(form: VirtualForm) -> str:
    """Port of resumeContext() — the preamble the app appends to the system
    instruction when reconnecting after a dropped session."""
    filled = [(k, label, q) for k, label, q in FIELD_META if field_filled(form, k)]
    if not filled:
        return ""
    lines = "\n".join(f"- {label}: {form.values[k]}" for k, label, _ in filled)
    unfilled = [(k, label, q) for k, label, q in FIELD_META if not field_filled(form, k)]
    if not unfilled:
        return (
            "\n\n--- RESUMING AN IN-PROGRESS SESSION ---\n"
            "The user already filled in EVERY field in an earlier session and the values are still on screen:\n"
            + lines
            + "\nDo NOT greet them as if starting fresh and do NOT re-ask any field. In one short sentence, "
            'welcome them back, then read back all the values and ask "Is everything correct?" so you can submit.'
        )
    _, label, q = unfilled[0]
    return (
        "\n\n--- RESUMING AN IN-PROGRESS SESSION ---\n"
        "The user already filled in these fields in an earlier session and the values are still on screen — "
        "treat them as already captured and confirmed unless the user asks to change one:\n"
        + lines
        + "\nDo NOT greet them as if starting fresh and do NOT re-ask any of the fields above. In one short sentence, "
        "welcome them back, then pick up exactly where they left off by asking for the next field: "
        + label
        + ' ("'
        + q
        + '").'
    )


async def ensure_serve(http):
    """serve.py must be up (geosearch + telemetry). Spawn it if it isn't.
    Returns the spawned process (terminate when done) or None if already up."""
    import asyncio

    import aiohttp

    try:
        async with http.get(SERVE_BASE + "/", timeout=aiohttp.ClientTimeout(total=2)):
            return None
    except Exception:
        pass
    print("⏳ serve.py not running — spawning it…")
    proc = await asyncio.create_subprocess_exec(
        "uv",
        "run",
        str(HERE.parent / "serve.py"),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    for _ in range(30):
        await asyncio.sleep(0.5)
        try:
            async with http.get(SERVE_BASE + "/", timeout=aiohttp.ClientTimeout(total=2)):
                return proc
        except Exception:
            continue
    proc.terminate()
    raise RuntimeError("could not start serve.py")


def parse_env_file(path: Path) -> dict[str, str]:
    """KEY=value file → dict (same rules as serve.py, minus its heavy imports)."""
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        out[key.strip()] = val.strip().strip('"').strip("'")
    return out


def system_instruction() -> str:
    """Pull SYSTEM_INSTRUCTION out of public/js/prompt.js (the single source of truth)."""
    src = PROMPT_JS.read_text()
    m = re.search(r"export const SYSTEM_INSTRUCTION = `(.*?)`;", src, re.DOTALL)
    if not m:
        raise RuntimeError("SYSTEM_INSTRUCTION not found in public/js/prompt.js")
    text = m.group(1)
    # The browser interpolates ${tap}/${TAP} by pointer type; evals are "taps".
    return text.replace("${tap}", "tap").replace("${TAP}", "Tap")


def tool_declarations() -> list[dict]:
    """Same function declarations as public/js/prompt.js's TOOLS (plain-dict form)."""
    return [
        {
            "function_declarations": [
                {
                    "name": "set_field",
                    "description": (
                        "Set or correct one field on the form. Call this the instant you "
                        "understand a value, and again whenever the user corrects it."
                    ),
                    "parameters": {
                        "type": "OBJECT",
                        "properties": {
                            "field": {
                                "type": "STRING",
                                "enum": FIELD_KEYS + ["feedback"],
                                "description": "Which field to fill. 'feedback' is the optional demo-feedback field.",
                            },
                            "value": {
                                "type": "STRING",
                                "description": (
                                    "The normalized value to display in that field. For 'address', this MUST "
                                    "be a New York City address in one of the five boroughs (Manhattan, "
                                    "Brooklyn, Queens, the Bronx, Staten Island) — never accept or set an "
                                    "address outside NYC. Include any apartment/unit/suite/floor the user "
                                    "gave (e.g. '171 E 2nd St #6D, Manhattan') — keep it in the value; it is "
                                    "preserved automatically."
                                ),
                            },
                        },
                        "required": ["field", "value"],
                    },
                },
                {
                    "name": "submit_form",
                    "description": "Submit the completed form. ONLY call after the user has verbally confirmed every value is correct.",
                    "parameters": {"type": "OBJECT", "properties": {}},
                },
            ]
        }
    ]


# ---------------------------------------------------------------------------
# Validators — ports of public/js/validators.js (keep in lockstep with the app;
# tests/unit + tests/js run the same fixture cases against both sides)
# ---------------------------------------------------------------------------


def phone_digits(v: str) -> str:
    return re.sub(r"\D", "", v or "")


def phone_info(v: str) -> dict:
    raw = (v or "").strip()
    plus = raw.startswith("+")
    d = phone_digits(raw)
    if not d:
        return {"ok": False, "reason": "empty", "n": 0}
    if plus:
        if len(d) < 8:
            return {"ok": False, "reason": "short", "n": len(d)}
        if len(d) > 15:
            return {"ok": False, "reason": "long", "n": len(d)}
        return {"ok": True, "intl": True, "n": len(d)}
    if len(d) == 10:
        return {"ok": True, "n": 10}
    if len(d) == 11 and d[0] == "1":
        return {"ok": True, "n": 11}
    if len(d) < 10:
        return {"ok": False, "reason": "short", "n": len(d)}
    return {"ok": False, "reason": "needsplus", "n": len(d)}


def dob_info(v: str) -> dict:
    if not v or not str(v).strip():
        return {"ok": False, "reason": "empty"}
    m = re.search(r"\b(\d{4})\b", str(v))
    if not m:
        return {"ok": False, "reason": "no_year"}
    year = int(m.group(1))
    if year < 1900:
        return {"ok": False, "reason": "too_early", "year": year}
    if year > 2026:
        return {"ok": False, "reason": "too_late", "year": year}
    return {"ok": True, "year": year}


def hh_size_info(v: str) -> dict:
    if v is None or not str(v).strip():
        return {"ok": False, "reason": "empty"}
    m = re.search(r"\d+", str(v))
    if not m:
        return {"ok": False, "reason": "no_number"}
    n = int(m.group(0))
    if n < 1:
        return {"ok": False, "reason": "too_small", "n": n}
    return {"ok": True, "n": min(n, 8)}


def income_info(v: str) -> dict:
    if v is None or not str(v).strip():
        return {"ok": False, "reason": "empty"}
    digits = re.sub(r"[^0-9.]", "", str(v))
    if not digits:
        return {"ok": False, "reason": "no_number"}
    try:
        amt = float(digits)
    except ValueError:
        return {"ok": False, "reason": "invalid"}
    if amt < 0:
        return {"ok": False, "reason": "invalid"}
    return {"ok": True, "amt": amt}


# Apartment/unit peeling — port of splitUnit()/withUnit() in public/js/validators.js.
UNIT_KW = (
    "apt|apartment|unit|ste|suite|rm|room|fl|floor|bldg|building|dept|department|"
    "lot|spc|space|trlr|trailer|hngr|hangar|slip|pier|penthouse|ph|no"
)
UNIT_RE = re.compile(
    r"[,\s]+(?:#\s*([A-Za-z0-9][A-Za-z0-9-]*)|("
    + UNIT_KW
    + r")\.?\s*#?\s*([A-Za-z0-9][A-Za-z0-9-]*))(?=$|[,\s])",
    re.IGNORECASE,
)


def split_unit(value: str) -> tuple[str, str]:
    v = (value or "").strip()
    m = UNIT_RE.search(v)
    if not m:
        return v, ""
    if m.group(2) and not (re.search(r"\d", m.group(3)) or len(m.group(3)) <= 2):
        return v, ""
    base = v[: m.start()] + " " + v[m.end() :]
    base = re.sub(r"\s*,\s*,\s*", ", ", base)
    base = re.sub(r"\s{2,}", " ", base)
    base = re.sub(r"\s+,", ",", base)
    base = base.strip(" ,")
    if m.group(1) is not None:
        unit = "#" + m.group(1)
    else:
        unit = m.group(2)[0].upper() + m.group(2)[1:].lower() + " " + m.group(3)
    return base, unit


def with_unit(full: str, unit: str) -> str:
    if not unit:
        return full
    i = full.find(",")
    return full + " " + unit if i == -1 else full[:i] + " " + unit + full[i:]


# ---------------------------------------------------------------------------
# Virtual form — replicates dispatchTool() responses byte-for-byte
# ---------------------------------------------------------------------------


@dataclass
class VirtualForm:
    """Headless stand-in for the browser UI: holds field state and produces the
    exact tool-response strings public/js/tools.js would send back to the model."""

    geosearch: Callable[[str], Awaitable[dict[str, Any]]]  # (text) -> the /api/geosearch JSON
    values: dict = field(default_factory=dict)
    addr_status: str = "none"  # none | checking | ok
    addr_unit: str = ""
    addr_choices: list = field(default_factory=list)
    submitted: bool = False
    tool_log: list = field(default_factory=list)

    async def dispatch(self, name: str, args: dict) -> str:
        result = await self._dispatch(name, args)
        self.tool_log.append({"name": name, "args": args, "result": result})
        return result

    async def _dispatch(self, name: str, args: dict) -> str:
        if name == "set_field":
            if not isinstance(args.get("value"), str):
                return "ok"
            fkey, value = args.get("field"), args["value"]
            if fkey == "feedback":
                self.values["feedback"] = value
                return "Saved to the optional demo-feedback field. Briefly acknowledge it and continue."
            if fkey not in FIELD_KEYS:
                return "ok"
            self.values[fkey] = value
            if fkey == "address":
                return await self._verify_address(value)
            if fkey == "phone":
                pi = phone_info(value)
                if not pi["ok"]:
                    if pi["reason"] == "short":
                        n = pi["n"]
                        return (
                            f"The phone number is NOT confirmed: only {n} digit{'' if n == 1 else 's'}"
                            " so far. A US number needs 10 digits (a leading 1 country code is fine). "
                            "Ask the user for the rest of the digits."
                        )
                    if pi["reason"] == "needsplus":
                        return (
                            "The phone number is NOT confirmed: more digits than a US number but no country code. "
                            "If it's international, set it again starting with '+' and the country code; "
                            "otherwise ask the user to repeat just their 10-digit number."
                        )
                    if pi["reason"] == "long":
                        return "The phone number is NOT confirmed: too many digits. Ask the user to repeat their number."
                    return "The phone number is NOT confirmed. Ask the user to repeat their phone number."
                return f"Phone number confirmed ({pi['n']} digits). Read it back so the user can catch any mistake."
            if fkey == "date_of_birth":
                info = dob_info(value)
                if not info["ok"]:
                    if info["reason"] == "too_early":
                        return (
                            f"The date of birth is NOT confirmed: {info['year']} is before 1900, which isn't allowed. "
                            "Ask the user to double-check and repeat their date of birth, then confirm it."
                        )
                    if info["reason"] == "too_late":
                        return (
                            f"The date of birth is NOT confirmed: {info['year']} is after 2026, which isn't allowed. "
                            "Ask the user to double-check and repeat their date of birth, then confirm it."
                        )
                    return (
                        "The date of birth is NOT confirmed — I couldn't read a valid year from it. Ask the user to "
                        "repeat their date of birth as month, day, and year, then confirm it. Do NOT call submit_form until it's valid."
                    )
                return f"Date of birth confirmed ({info['year']}). Read it back as 'Month D, YYYY' so the user can confirm."
            if fkey == "household_size":
                info = hh_size_info(value)
                if not info["ok"]:
                    return (
                        "The household size is NOT confirmed — I need a whole number of people from 1 to 8 or more. "
                        "Ask the user how many people live and eat together in their home, then read the number back."
                    )
                n = info["n"]
                return (
                    f"Household size confirmed ({'8 or more' if n == 8 else n} "
                    f"{'person' if n == 1 else 'people'}). Read it back so the user can confirm."
                )
            if fkey == "household_income":
                info = income_info(value)
                if not info["ok"]:
                    return (
                        "The monthly household income is NOT confirmed — I need a dollar amount (say zero if there's no income). "
                        "Ask the user roughly how much the household earns each month before taxes, then read it back."
                    )
                return "Monthly household income confirmed. Read the amount back so the user can confirm."
            if fkey == "preferred_language":
                return f"Preferred language set to {value}. Briefly confirm it and continue."
            return "ok"

        if name == "submit_form":
            if self._all_filled():
                self.submitted = True
                return "submitted"
            problems = []
            v = self.values
            if v.get("address") and self.addr_status != "ok":
                problems.append("the address is not confirmed (it needs a valid NYC city/borough)")
            if v.get("phone") and not phone_info(v["phone"])["ok"]:
                problems.append(
                    "the phone number is not confirmed (10 digits, or a country code with +)"
                )
            if v.get("date_of_birth") and not dob_info(v["date_of_birth"])["ok"]:
                problems.append(
                    "the date of birth is not confirmed (the year must be between 1900 and 2026)"
                )
            if v.get("household_size") and not hh_size_info(v["household_size"])["ok"]:
                problems.append("the household size is not confirmed (1 to 8 or more people)")
            if v.get("household_income") and not income_info(v["household_income"])["ok"]:
                problems.append(
                    "the monthly household income is not confirmed (it needs a dollar amount)"
                )
            if problems:
                return (
                    "Cannot submit yet: "
                    + "; ".join(problems)
                    + ". Fix each with set_field and re-confirm with the user before calling submit_form again."
                )
            return "not all fields are filled yet"

        return "unknown tool"

    def _all_filled(self) -> bool:
        v = self.values
        if not all(v.get(k) for k in FIELD_KEYS):
            return False
        return (
            self.addr_status == "ok"
            and phone_info(v["phone"])["ok"]
            and dob_info(v["date_of_birth"])["ok"]
            and hh_size_info(v["household_size"])["ok"]
            and income_info(v["household_income"])["ok"]
        )

    async def _verify_address(self, value: str) -> str:
        """Port of verifyAddress() + the address branch of dispatchTool()."""
        is_pick = any(c["full"] == value for c in self.addr_choices)
        base, unit = split_unit(value)
        if unit:
            self.addr_unit = unit
        elif not is_pick:
            self.addr_unit = ""
        self.addr_status = "checking"
        self.addr_choices = []
        try:
            j = await self.geosearch(base)
        except Exception:
            self.addr_status = "none"
            j = {"status": "error"}
        if j and j.get("status") == "confirmed" and j.get("full"):
            self.addr_status = "ok"
            full = with_unit(j["full"], self.addr_unit)
            self.values["address"] = full
            if j.get("degraded"):
                return (
                    "Address accepted as: "
                    + full
                    + " (the address lookup is temporarily unavailable, so it wasn't independently verified). "
                    + "Read this address back to the user, INCLUDING the borough/city, and ask them to confirm it."
                )
            return (
                "Address confirmed by NYC geosearch as: "
                + full
                + ". Read this exact full address back to the user, INCLUDING the borough/city, and ask them to confirm it."
            )
        self.addr_status = "none"
        raw_cands = j.get("candidates") if j else None
        cands: list[dict[str, Any]] = raw_cands if isinstance(raw_cands, list) else []
        self.addr_choices = [
            {"letter": "ABCD"[i], "full": c["full"], "borough": c.get("borough", "")}
            for i, c in enumerate(cands[:4])
        ]
        if self.addr_choices:
            opts = "; ".join(c["letter"] + ") " + c["full"] for c in self.addr_choices)
            letters = ", ".join(c["letter"] for c in self.addr_choices)
            split = (
                "That street exists in more than one borough."
                if j.get("reason") == "multiple_boroughs"
                else "I couldn't pin that address down exactly, so here are the closest matches."
            )
            return (
                split
                + " The options are now shown on screen as lettered buttons: "
                + opts
                + ". Read them out briefly and ask the user to pick — they can tap a button or just say the letter ("
                + letters
                + "). When they choose, call set_field for the address with that option's full address. "
                + "If none of them is right, ask them to repeat the street number, street, and borough. Do not move on until the address is confirmed."
            )
        return (
            "Could not find that address at all. A city or borough is REQUIRED — ask the user to repeat "
            "the street number, street, and city/borough, then confirm again."
        )
