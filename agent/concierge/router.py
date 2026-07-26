"""Pre-local routing: skip the local-model attempt entirely for request shapes that NEVER succeed
locally today (owner-directed, 2026-07-25, from a cross-architecture eval sweep — gpt-oss, gemma4, and
ministral-3:8b all failed the SAME 8 categories regardless of which verifier judged them, so this is a
genuine capability ceiling, not a verifier-calibration artifact). Going straight to cloud for these saves
a wasted local attempt + verifier round-trip on a request that's going to escalate anyway.

Two root causes observed: (1) read-only questions (bills/calendar/chores) where local models under-call
the read tool or answer off-topic; (2) compound/stateful/bulk actions (bulk-clear, vague goal-tracking,
full meal-plan generation, meal-plan swap, bill-payment refusal) needing more reasoning than a single
tool-call mapping. Pure + keyless-testable, mirrors verifier.py's separation of logic from I/O.

RE-DERIVE THIS LIST whenever CONCIERGE_LOCAL_MODEL changes: re-run agent/evals/run_eval.py and rebuild
it from the categories that still escalate on every candidate — cloud always succeeds, so a stale entry
here never produces a failure signal on its own.
"""
from __future__ import annotations

import re

_WEEKDAY = r"(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"

# All patterns are conjunctions of (?=.*\bword\b) lookaheads: re.S so `.` crosses newlines (a pasted
# week plan IS multi-line), and matched with .match() — anchoring at 0 is equivalent for pure
# lookahead conjunctions and linear, where .search() re-tries the conjunction at every offset (O(n^2)).
_PATTERNS = (
    # "delete all of Ava's chores" — bulk chore clear
    re.compile(r"(?=.*\b(?:delete|clear|remove)\b)(?=.*\ball\b)(?=.*\bchores?\b)", re.I | re.S),
    # "plan a picnic ... and track it as a goal" — vague ask -> concrete goal
    re.compile(r"(?=.*\btrack\b)(?=.*\bgoals?\b)", re.I | re.S),
    # "what bills do we have coming up?" — read-only bill query
    re.compile(r"(?=.*\bbills?\b)(?=.*\b(?:what|when|coming up|due|owe|upcoming)\b)", re.I | re.S),
    # "what's on our calendar this week?" — read-only calendar query
    re.compile(r"(?=.*\bcalendar\b)(?=.*\bwhat\b)", re.I | re.S),
    # "what chores does Max have today?" — read-only chore query
    re.compile(r"(?=.*\bchores?\b)(?=.*\bwhat\b)", re.I | re.S),
    # "Pay the electric bill with our card." — payment refusal, bill-shaped
    re.compile(r"(?=.*\bpay\b)(?=.*\bbills?\b)", re.I | re.S),
    # "here's next week's dinner plan: Monday X, Tuesday Y, ..." — full meal-plan given
    re.compile(r"(?=.*\b(?:dinner|meal)\s*plan\b)(?=.*\b" + _WEEKDAY + r"\b)", re.I | re.S),
    # "swap Thursday's dinner to rajma" — stateful partial meal-plan update
    re.compile(r"(?=.*\bswap\b)(?=.*\b(?:breakfast|lunch|dinner|meal)\b)", re.I | re.S),
)


def should_skip_local(message: str) -> bool:
    """True if this request shape should go straight to the cloud chain, skipping the local attempt.
    Pure string match — no I/O, no model call. Fail-safe: an empty/None message never skips (defaults
    to trying local, same as today's behavior)."""
    m = message or ""
    return any(p.match(m) for p in _PATTERNS)
