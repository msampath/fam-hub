"""Per-key fixed-window rate limiter for the agent's public /chat cost guard (H1).

The agent service now deploys `--no-allow-unauthenticated` on Cloud Run (the web tier attaches a Google ID
token to reach it — H1), so IAM is the primary gate. This per-IP cap is defense-in-depth ON TOP of that gate:
if a token ever leaks, it stops anyone racking up owner-paid Gemini calls (each turn also fans out MCP children).
Pure + unit-tested — the clock is injected so tests need no sleeps. In-process (a multi-instance deploy wants
a shared counter — Wave 4); this bounds a single instance's blast radius. `AGENT_RATE_LIMIT_PER_MIN` tunes it;
0 disables (local dev / tests).
"""
import os

RATE_MAX = int(os.environ.get("AGENT_RATE_LIMIT_PER_MIN", "20"))
WINDOW_S = 60.0
_hits: dict[str, tuple[int, float]] = {}


def rate_ok(key: str, now: float, max_per_window: int | None = None) -> bool:
    """True if `key` may proceed at time `now` (monotonic seconds). Fixed 60s window; opportunistic prune."""
    limit = RATE_MAX if max_per_window is None else max_per_window
    if limit <= 0:
        return True
    count, reset_at = _hits.get(key, (0, 0.0))
    if now >= reset_at:
        _hits[key] = (1, now + WINDOW_S)
        if len(_hits) > 512:  # keep the map from growing unbounded under an IP flood
            for k, (_, r) in list(_hits.items()):
                if now >= r:
                    _hits.pop(k, None)
        return True
    if count >= limit:
        return False
    _hits[key] = (count + 1, reset_at)
    return True


def reset() -> None:
    """Clear all counters (tests)."""
    _hits.clear()


def client_key_from_xff(xff: str, peer: str | None) -> str:
    """Per-IP rate-limit key from the X-Forwarded-For header + socket peer.

    Cloud Run APPENDS the real caller IP to the RIGHT of X-Forwarded-For and does NOT strip client-supplied
    values, so the RIGHTMOST entry is the trustworthy one — this mirrors the Node service's `trust proxy: 1`
    (server.ts), which reads the same end. Reading the leftmost value would let a caller forge X-Forwarded-For
    and mint a fresh bucket on every request, defeating the cap entirely. Falls back to the socket peer, then
    'anon', when no XFF is present (direct connection / local dev)."""
    rightmost = xff.split(",")[-1].strip() if xff else ""
    return rightmost or (peer or "anon")
