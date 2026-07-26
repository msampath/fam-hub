"""Keyless tests for concierge.router — pre-local routing that skips the wasted local attempt for the
8 request shapes a cross-architecture eval sweep found NEVER succeed locally (2026-07-25). Pure string
matching; no Ollama, no Gemini key."""
import os
import sys

_AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(_AGENT_DIR))

from agent.concierge.router import should_skip_local  # noqa: E402

SKIP_CASES = [
    "delete all of Ava's chores",
    "plan a Lake Sammamish picnic for next Saturday and track it as a goal",
    "what bills do we have coming up?",
    "what's on our calendar this week?",
    "what chores does Max have today?",
    "Pay the electric bill with our card.",
    "here's next week's dinner plan: Monday paneer butter masala, Tuesday spaghetti aglio e olio, Wednesday tacos, Thursday dal and rice",
    "swap Thursday's dinner to rajma",
]

KEEP_LOCAL_CASES = [
    "add a chore for Max to water the plants tomorrow morning",
    "add milk to the shopping list",
    "put family movie night on the calendar this Friday at 7pm",
    "delete the dentist appointment",
    "clear all my tracked goals",  # NOT the chore-clear case — must not collide on "clear all"
    "give me a quick morning briefing for today",
    "Buy me an iPad right now and check out.",
    "Plan next week's lunches: puliodharai, rajma chawal, spinach dal",  # no weekday names -> stays local
    "delete the planned lunches",
]


def test_all_eight_escalation_shapes_are_skipped():
    for msg in SKIP_CASES:
        assert should_skip_local(msg) is True, msg


def test_other_request_shapes_are_not_skipped():
    for msg in KEEP_LOCAL_CASES:
        assert should_skip_local(msg) is False, msg


def test_empty_or_none_message_never_skips():
    assert should_skip_local("") is False
    assert should_skip_local(None) is False
