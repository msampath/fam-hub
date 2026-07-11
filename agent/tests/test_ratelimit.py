"""H1 cost-guard: the agent /chat per-IP rate limiter. Pure + clock-injected — no boot guard, no key, no sleeps."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from concierge.ratelimit import rate_ok, reset, client_key_from_xff  # noqa: E402


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


def test_client_key_reads_rightmost_xff_not_spoofable_leftmost():
    # Cloud Run appends the real caller IP on the RIGHT of X-Forwarded-For. A forged LEFTMOST value must NOT
    # change the key — otherwise an attacker rotates it to mint a fresh bucket every request (defeats the cap).
    assert client_key_from_xff("1.2.3.4", "10.0.0.1") == "1.2.3.4"          # single hop → that IP
    assert client_key_from_xff("evil, 1.2.3.4", "10.0.0.1") == "1.2.3.4"     # forged leftmost ignored
    # Same real client behind two different forged leftmost values → SAME bucket (the bypass is closed).
    assert client_key_from_xff("spoof-a, 1.2.3.4", "10.0.0.1") == client_key_from_xff("spoof-b, 1.2.3.4", "10.0.0.1")


def test_client_key_falls_back_to_peer_then_anon():
    assert client_key_from_xff("", "10.0.0.1") == "10.0.0.1"   # no XFF (direct/local) → socket peer
    assert client_key_from_xff("", None) == "anon"             # no XFF, no peer → anon
