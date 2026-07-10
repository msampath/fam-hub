"""H1 cost-guard: the agent /chat per-IP rate limiter. Pure + clock-injected — no boot guard, no key, no sleeps."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from concierge.ratelimit import rate_ok, reset  # noqa: E402


def test_allows_up_to_max_then_blocks_in_window():
    reset()
    t = 100.0
    assert [rate_ok("1.2.3.4", t, 3) for _ in range(3)] == [True, True, True]
    assert rate_ok("1.2.3.4", t, 3) is False        # 4th within the window → blocked
    assert rate_ok("9.9.9.9", t, 3) is True          # a different IP has its own bucket
    assert rate_ok("1.2.3.4", t + 61, 3) is True     # window rolled over → allowed again


def test_disabled_when_limit_zero():
    reset()
    assert all(rate_ok("x", 1.0, 0) for _ in range(50))
