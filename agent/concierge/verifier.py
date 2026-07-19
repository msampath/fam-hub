"""Small-model verifier for the LOCAL agent head (owner-directed design, 2026-07-19).

qwen2.5 (the Express copilot's model, resident on the other GPU) CHECKS every answer the local
gpt-oss head produces before it is returned: did the reply actually handle the request, with the
tool calls it needs/claims? An INSUFFICIENT verdict makes api.py advance the turn to the cloud
chain — this is the accuracy fallback the plain chain cannot provide (the chain only catches HARD
failures; a confident wrong answer would otherwise return as-is).

Fail-open by design: any verifier error (Ollama down, timeout, unparseable verdict) returns
sufficient=True — the verifier may only ADD escalation, never block or slow-fail a turn.
Pure helpers (prompt build + verdict parse) are separated from the one I/O call for keyless tests.
"""
from __future__ import annotations

import json
import os
import urllib.request

VERIFIER_ENABLED = os.environ.get("CONCIERGE_VERIFIER_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")
VERIFIER_MODEL = os.environ.get("CONCIERGE_VERIFIER_MODEL", "qwen2.5:14b")
VERIFIER_URL = (os.environ.get("LOCAL_LLM_URL") or "http://localhost:11434").rstrip("/")
VERIFIER_TIMEOUT = float(os.environ.get("CONCIERGE_VERIFIER_TIMEOUT", "30"))

_SYSTEM = (
    "You are a strict output checker for a family-household assistant. Given the parent's REQUEST, the "
    "assistant's REPLY, and the TOOL CALLS it made, decide if the response SUFFICIENTLY handled the request.\n"
    "INSUFFICIENT when: the request clearly asks for an action in the household app (add / create / schedule / "
    "plan / track / delete / clear / update / swap something) but NO matching tool call was made; or the reply "
    "claims or implies an action was done ('I've added/tracked/staged/planned/set up ...') with no matching "
    "tool call behind it.\n"
    "SUFFICIENT when: a matching tool call exists; or the request is a read-only question, greeting, or "
    "out-of-scope ask and the reply answers/declines it; or the reply honestly asks a clarifying question or "
    "plainly says it cannot do it (an honest refusal or question is sufficient — never punish honesty).\n"
    "Judge ONLY sufficiency, not style or wording. Reply with JSON only."
)

_SCHEMA = {
    "type": "object",
    "properties": {"sufficient": {"type": "boolean"}, "reason": {"type": "string"}},
    "required": ["sufficient"],
}


def build_verdict_prompt(message: str, reply: str, tool_names: list[str]) -> str:
    """The user-turn content for the verifier call. Pure → unit-tested keyless."""
    tools = ", ".join(t for t in tool_names if t) or "(none)"
    return (
        f"REQUEST: {message}\n\n"
        f"REPLY: {reply}\n\n"
        f"TOOL CALLS MADE: {tools}\n\n"
        'Return {"sufficient": true|false, "reason": "<short>"}.'
    )


def parse_verdict(raw: str) -> tuple[bool, str]:
    """Parse the verifier's JSON verdict. Unparseable → fail-open (sufficient). Pure → unit-tested."""
    try:
        d = json.loads(raw)
        return bool(d.get("sufficient", True)), str(d.get("reason") or "")
    except Exception:
        return True, "unparseable verdict (fail-open)"


def verify_local_answer(message: str, reply: str, tool_names: list[str], url: str | None = None) -> tuple[bool, str]:
    """One constrained-JSON verdict call to the verifier model. SYNCHRONOUS (call via asyncio.to_thread).
    Returns (sufficient, reason); every failure path returns (True, ...) — fail-open."""
    try:
        body = json.dumps({
            "model": VERIFIER_MODEL,
            "messages": [
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": build_verdict_prompt(message, reply, tool_names)},
            ],
            "format": _SCHEMA,
            "stream": False,
            "options": {"temperature": 0, "num_predict": 200},
            "keep_alive": "30m",
        }).encode()
        req = urllib.request.Request(
            f"{(url or VERIFIER_URL)}/api/chat", data=body,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=VERIFIER_TIMEOUT) as r:
            data = json.loads(r.read().decode())
        return parse_verdict(str((data.get("message") or {}).get("content") or ""))
    except Exception as err:
        return True, f"verifier unavailable ({err!r})"
