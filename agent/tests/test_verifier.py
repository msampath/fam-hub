"""Keyless tests for the small-model verifier (concierge.verifier) — the owner-directed accuracy
tier where qwen checks the local gpt-oss head's answers and an insufficient verdict escalates the
turn to the cloud chain. Pure helpers + the fail-open I/O contract; no Ollama, no Gemini key."""
import os
import sys

# Repo root on sys.path so `agent` resolves as a package (same scheme as test_eval.py).
_AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(_AGENT_DIR))

from agent.concierge.verifier import build_verdict_prompt, parse_verdict, verify_local_answer  # noqa: E402


def test_verdict_prompt_carries_request_reply_and_tools():
    p = build_verdict_prompt("track it as a goal", "Great picnic plan!", ["find_places", "suggest_event"])
    assert "REQUEST: track it as a goal" in p
    assert "REPLY: Great picnic plan!" in p
    assert "find_places, suggest_event" in p


def test_verdict_prompt_shows_none_for_no_tools():
    assert "(none)" in build_verdict_prompt("hi", "hello!", [])


def test_parse_verdict_reads_both_outcomes():
    assert parse_verdict('{"sufficient": true, "reason": "answered"}') == (True, "answered")
    ok, reason = parse_verdict('{"sufficient": false, "reason": "asked to track a goal, no set_goal call"}')
    assert ok is False and "set_goal" in reason


def test_parse_verdict_fails_open_on_garbage():
    # An unparseable verdict must NEVER block a turn — sufficient=True with the fail-open marker.
    ok, reason = parse_verdict("not json at all")
    assert ok is True and "fail-open" in reason


def test_verify_local_answer_fails_open_when_verifier_unreachable():
    # Point at a dead port: the call must return sufficient=True (verifier can only ADD escalation).
    ok, reason = verify_local_answer("add milk", "done!", [], url="http://127.0.0.1:9")
    assert ok is True
    assert "unavailable" in reason
