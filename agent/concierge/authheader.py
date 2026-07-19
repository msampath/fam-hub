"""Pure HTTP auth-header parsing for the agent service.

Kept OUT of api.py so it can be unit-tested WITHOUT importing api.py — which raises SystemExit at import
time when no GOOGLE_API_KEY/GEMINI_API_KEY is set (the boot guard), so a test that imports api.py just to
reach this helper self-skips keyless and the H1 security assertion never actually runs in CI. No I/O, no
Gemini, no key needed.
"""
from __future__ import annotations


def extract_bearer(header_value: str | None) -> str | None:
    """Pull the token out of a `Bearer <token>` header value (case-insensitive scheme). Returns None for
    anything else — missing header, wrong scheme, or an empty token after the prefix."""
    if not header_value or not header_value.lower().startswith("bearer "):
        return None
    return header_value[7:].strip() or None
