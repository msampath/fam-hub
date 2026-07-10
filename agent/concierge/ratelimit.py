"""Per-key fixed-window rate limiter for the agent's public /chat cost guard (H1).

The agent service runs `--allow-unauthenticated` on Cloud Run, so an open /chat would let anyone rack up
owner-paid Gemini calls (each turn also fans out MCP children). This caps requests per client IP per window.
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
