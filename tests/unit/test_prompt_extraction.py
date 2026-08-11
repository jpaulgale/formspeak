"""The eval harness must keep extracting the LIVE prompt from the app.

formspeak_env.system_instruction() reads public/js/prompt.js at runtime so the
evals can never drift from what ships. These tests pin that contract: the
extraction works, the interpolations are resolved, and the tool enum tracks the
form's field list.
"""

import sys
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TESTS_DIR))

from formspeak_env import FIELD_KEYS, system_instruction, tool_declarations


def test_system_instruction_extracts():
    text = system_instruction()
    assert text.startswith('You are "FormSpeak"')
    assert "NEVER call submit_form" in text


def test_interpolations_resolved():
    # The browser interpolates ${tap}/${TAP} by pointer type; the harness
    # substitutes "tap"/"Tap". Nothing template-shaped may survive.
    assert "${" not in system_instruction()


def test_prompt_names_every_field():
    text = system_instruction()
    for key in FIELD_KEYS:
        assert key in text, f"prompt mentions {key}"


def test_tool_enum_tracks_field_list():
    decls = tool_declarations()[0]["function_declarations"]
    set_field = next(d for d in decls if d["name"] == "set_field")
    assert set_field["parameters"]["properties"]["field"]["enum"] == FIELD_KEYS + ["feedback"]
    assert any(d["name"] == "submit_form" for d in decls)
