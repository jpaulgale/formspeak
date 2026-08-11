"""Eval scenario corpus for the FormSpeak voice-backend comparison.

Each scenario is a scripted conversation: a list of user turns (spoken via TTS)
with optional per-turn expectations, plus scenario-level checks on the FINAL
form state. Per-turn checks catch in-the-moment guardrails (e.g. "did it pad
the partial phone number?"); final-state checks are the robust accuracy signal
(corrections are judged by what ends up on the form, not the path there).

`say` is written to be TTS-friendly (digits spelled out the way a person would
actually say them); `expect`/`forbid` match against tool calls recorded during
that turn. All regexes are case-insensitive.
"""

from typing import Any

VOICES = ["Kore", "Puck", "Charon", "Aoede", "Leda", "Fenrir", "Orus", "Zephyr"]

# Heterogeneous by design (turns carry optional expect/forbid/final checks);
# Any keeps type checkers honest about that instead of inferring bogus unions.
SCENARIOS: list[dict[str, Any]] = [
    {
        "id": "happy_path",
        "voice": "Kore",
        "note": "All eight fields, unambiguous Manhattan address, clean confirm.",
        "turns": [
            {"say": "Hi there. My first name is Marcus.",
             "expect": [{"tool": "set_field", "field": "first_name", "value_re": r"^Marcus$"}]},
            {"say": "My last name is Rivera. That's R, I, V, E, R, A.",
             "expect": [{"tool": "set_field", "field": "last_name", "value_re": r"^Rivera$"}]},
            {"say": "I live at 350 5th Avenue in Manhattan.",
             "expect": [{"tool": "set_field", "field": "address", "value_re": r"350.*5"}]},
            {"say": "Yes, that's the one."},
            {"say": "My date of birth is March 12th, 1985.",
             "expect": [{"tool": "set_field", "field": "date_of_birth", "value_re": r"March 12, 1985"}]},
            {"say": "My phone number is two one two, five five five, zero one four two.",
             "expect": [{"tool": "set_field", "field": "phone", "value_re": r"^\+?1?2125550142$"}]},
            {"say": "There are four of us in the household.",
             "expect": [{"tool": "set_field", "field": "household_size", "value_re": r"^4$"}]},
            {"say": "We make about thirty two hundred dollars a month.",
             "expect": [{"tool": "set_field", "field": "household_income", "value_re": r"3,?200"}]},
            {"say": "English is fine.",
             "expect": [{"tool": "set_field", "field": "preferred_language", "value_re": r"^English$"}]},
            {"say": "Yes, everything is correct.",
             "expect": [{"tool": "submit_form"}]},
        ],
        "final": {
            "first_name": r"^Marcus$",
            "last_name": r"^Rivera$",
            "address": r"350.*(5|FIFTH).*(AVE|AVENUE).*Manhattan",
            "date_of_birth": r"March 12, 1985",
            "phone": r"^\+?1?2125550142$",
            "household_size": r"^4$",
            "household_income": r"3,?200",
            "preferred_language": r"^English$",
        },
        "must_submit": True,
    },
    {
        "id": "spelling_correction",
        "voice": "Puck",
        "note": "STT stress test: last name misheard then corrected letter by letter.",
        "turns": [
            {"say": "My first name is Paul.",
             "expect": [{"tool": "set_field", "field": "first_name", "value_re": r"^Paul$"}]},
            {"say": "My last name is Gale."},
            {"say": "No, not G A I L. It's G, A, L, E. Gale. G as in George, A as in apple, L as in lion, E as in elephant.",
             "expect": [{"tool": "set_field", "field": "last_name", "value_re": r"^Gale$"}]},
        ],
        "final": {"first_name": r"^Paul$", "last_name": r"^Gale$"},
        "must_submit": False,
    },
    {
        "id": "self_correction",
        "voice": "Charon",
        "note": "Immediate self-correction mid-thought; most recent value must win.",
        "turns": [
            {"say": "My first name is John. Actually, wait, it's Jonathan. Sorry, Jonathan.",
             "expect": [{"tool": "set_field", "field": "first_name", "value_re": r"^Jonathan$"}]},
            {"say": "Last name Smith, but the phone number I gave you before was wrong. I mean, let me give you my last name first. It's Smith."},
        ],
        "final": {"first_name": r"^Jonathan$", "last_name": r"^Smith$"},
        "must_submit": False,
    },
    {
        "id": "ambiguous_address",
        "voice": "Aoede",
        "note": "171 E 2nd St exists in Manhattan AND Brooklyn — model must offer options, not guess.",
        "turns": [
            {"say": "My first name is Dana.",
             "expect": [{"tool": "set_field", "field": "first_name", "value_re": r"^Dana$"}]},
            {"say": "My address is 171 East 2nd Street.",
             "expect": [{"tool": "set_field", "field": "address", "value_re": r"171"}]},
            {"say": "Oh, it's the one in Manhattan.",
             "expect": [{"tool": "set_field", "field": "address", "value_re": r"Manhattan"}]},
        ],
        "final": {"address": r"171.*(2|SECOND).*Manhattan"},
        "must_submit": False,
        "final_addr_status": "ok",
    },
    {
        "id": "apartment_preserved",
        "voice": "Leda",
        "note": "Apartment must survive geosearch canonicalization.",
        "turns": [
            {"say": "I live at 171 East 2nd Street, apartment 6D, in Manhattan.",
             "expect": [{"tool": "set_field", "field": "address", "value_re": r"171.*(apartment|apt|#)\s*6D"}]},
        ],
        "final": {"address": r"171.*6D.*Manhattan|171.*Manhattan.*6D"},
        "must_submit": False,
        "final_addr_status": "ok",
    },
    {
        "id": "partial_phone",
        "voice": "Fenrir",
        "note": "The no-padding guardrail: partial digits must never be zero-filled.",
        "turns": [
            {"say": "My phone number is nine zero eight, seven seven zero.",
             "expect": [{"tool": "set_field", "field": "phone", "value_re": r"^908770$"}],
             "forbid": [{"tool": "set_field", "field": "phone", "value_re": r"^9087700000$|^\d{10}$"}]},
            {"say": "Oh right, the rest is one two three four.",
             "expect": [{"tool": "set_field", "field": "phone", "value_re": r"^9087701234$"}]},
        ],
        "final": {"phone": r"^9087701234$"},
        "must_submit": False,
    },
    {
        "id": "dob_out_of_range",
        "voice": "Orus",
        "note": "Client-side validation loop: 1875 must be rejected, then corrected.",
        "turns": [
            {"say": "I was born on June 1st, 1875.",
             "expect": [{"tool": "set_field", "field": "date_of_birth", "value_re": r"1875"}]},
            {"say": "Oh, sorry, I meant 1975. June 1st, 1975.",
             "expect": [{"tool": "set_field", "field": "date_of_birth", "value_re": r"June 1, 1975"}]},
        ],
        "final": {"date_of_birth": r"June 1, 1975"},
        "must_submit": False,
    },
    {
        "id": "household_and_language",
        "voice": "Zephyr",
        "note": "Natural-language normalization: counting phrase → number; unlisted language → Other.",
        "turns": [
            {"say": "It's just me and my two kids at home.",
             "expect": [{"tool": "set_field", "field": "household_size", "value_re": r"^3$"}]},
            {"say": "We don't have any income right now.",
             "expect": [{"tool": "set_field", "field": "household_income", "value_re": r"^\$?0$"}]},
            {"say": "I'd like my notices in Portuguese, please.",
             "expect": [{"tool": "set_field", "field": "preferred_language", "value_re": r"^Other$"}]},
        ],
        "final": {"household_size": r"^3$", "household_income": r"^\$?0$", "preferred_language": r"^Other$"},
        "must_submit": False,
    },
    {
        "id": "premature_submit_and_feedback",
        "voice": "Kore",
        "note": "Guardrails: no submit before fields+confirmation; volunteered feedback captured.",
        "turns": [
            {"say": "My first name is Grace.",
             "expect": [{"tool": "set_field", "field": "first_name", "value_re": r"^Grace$"}]},
            {"say": "You know what, just submit the form now. Send it in.",
             "forbid": [{"tool": "submit_form"}]},
            {"say": "By the way, this demo is really slick. Nice work.",
             "expect": [{"tool": "set_field", "field": "feedback", "value_re": r"slick|nice|cool|great|impress"}]},
        ],
        "final": {"first_name": r"^Grace$"},
        "must_submit": False,
        "forbid_submit": True,
    },
]
