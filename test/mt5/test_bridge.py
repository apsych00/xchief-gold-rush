"""Tests for mt5/bridge.py's tick de-dup and message shape - no real
terminal, no real websocket server: connect_terminal and the tick functions
are exercised directly against a fake mt5 module and fake tick objects.
Run: python -m pytest test/mt5/test_bridge.py  (or: python -m unittest discover -s test/mt5)
"""

import os
import sys
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "mt5"))

from bridge import Bridge, connect_terminal, is_duplicate, is_forex_market_hours, make_tick_message  # noqa: E402


def fake_tick(bid, ask, time_msc=None, time=None):
    return SimpleNamespace(bid=bid, ask=ask, time_msc=time_msc, time=time)


class FakeMt5:
    """Fake MetaTrader5 module: scripted results, no network, no terminal."""

    def __init__(self, initialize_ok=True, login_ok=True, symbol_select_ok=True):
        self.initialize_ok = initialize_ok
        self.login_ok = login_ok
        self.symbol_select_ok = symbol_select_ok
        self.calls = {"initialize": 0, "login": None, "symbol_select": None, "shutdown": 0}

    def initialize(self):
        self.calls["initialize"] += 1
        return self.initialize_ok

    def login(self, login, password=None, server=None):
        self.calls["login"] = (login, password, server)
        return self.login_ok

    def symbol_select(self, symbol, enable):
        self.calls["symbol_select"] = (symbol, enable)
        return self.symbol_select_ok

    def shutdown(self):
        self.calls["shutdown"] += 1

    def last_error(self):
        return (0, "fake error")


class MakeTickMessageTest(unittest.TestCase):
    def test_mid_from_bid_ask_with_time_msc(self):
        tick = fake_tick(bid=4355.1, ask=4355.3, time_msc=1700000000123)
        msg = make_tick_message(tick)
        self.assertAlmostEqual(msg["price"], 4355.2)
        self.assertEqual(msg["bid"], 4355.1)
        self.assertEqual(msg["ask"], 4355.3)
        self.assertEqual(msg["t"], 1700000000123)

    def test_falls_back_to_time_seconds_when_no_time_msc(self):
        tick = fake_tick(bid=4355.0, ask=4355.2, time_msc=0, time=1700000000)
        msg = make_tick_message(tick)
        self.assertEqual(msg["t"], 1700000000000)

    def test_message_has_exactly_the_four_expected_keys(self):
        tick = fake_tick(bid=4355.0, ask=4355.2, time_msc=1700000000000)
        msg = make_tick_message(tick)
        self.assertEqual(sorted(msg.keys()), ["ask", "bid", "price", "t"])


class IsDuplicateTest(unittest.TestCase):
    def test_first_tick_is_never_a_duplicate(self):
        cur = {"price": 4355.2, "bid": 4355.1, "ask": 4355.3, "t": 1}
        self.assertFalse(is_duplicate(None, cur))

    def test_identical_bid_ask_time_is_a_duplicate(self):
        prev = {"price": 4355.2, "bid": 4355.1, "ask": 4355.3, "t": 1}
        cur = {"price": 4355.2, "bid": 4355.1, "ask": 4355.3, "t": 1}
        self.assertTrue(is_duplicate(prev, cur))

    def test_a_changed_bid_is_not_a_duplicate(self):
        prev = {"price": 4355.2, "bid": 4355.1, "ask": 4355.3, "t": 1}
        cur = {"price": 4355.25, "bid": 4355.2, "ask": 4355.3, "t": 1}
        self.assertFalse(is_duplicate(prev, cur))

    def test_same_bid_ask_but_new_time_is_not_a_duplicate(self):
        prev = {"price": 4355.2, "bid": 4355.1, "ask": 4355.3, "t": 1}
        cur = {"price": 4355.2, "bid": 4355.1, "ask": 4355.3, "t": 2}
        self.assertFalse(is_duplicate(prev, cur))


class ConnectTerminalTest(unittest.TestCase):
    def test_success_calls_initialize_login_symbol_select_in_order(self):
        mt5 = FakeMt5()
        ok = connect_terminal(mt5, 12345, "investor-pw", "XChief-Live", "XAUUSD")
        self.assertTrue(ok)
        self.assertEqual(mt5.calls["initialize"], 1)
        self.assertEqual(mt5.calls["login"], (12345, "investor-pw", "XChief-Live"))
        self.assertEqual(mt5.calls["symbol_select"], ("XAUUSD", True))
        self.assertEqual(mt5.calls["shutdown"], 0)

    def test_initialize_failure_stops_before_login(self):
        mt5 = FakeMt5(initialize_ok=False)
        ok = connect_terminal(mt5, 1, "p", "s", "XAUUSD")
        self.assertFalse(ok)
        self.assertIsNone(mt5.calls["login"])
        self.assertEqual(mt5.calls["shutdown"], 0)

    def test_login_failure_shuts_down_and_reports_false(self):
        mt5 = FakeMt5(login_ok=False)
        ok = connect_terminal(mt5, 1, "p", "s", "XAUUSD")
        self.assertFalse(ok)
        self.assertIsNone(mt5.calls["symbol_select"])
        self.assertEqual(mt5.calls["shutdown"], 1)

    def test_symbol_select_failure_shuts_down_and_reports_false(self):
        mt5 = FakeMt5(symbol_select_ok=False)
        ok = connect_terminal(mt5, 1, "p", "s", "XAUUSD")
        self.assertFalse(ok)
        self.assertEqual(mt5.calls["shutdown"], 1)


class IsForexMarketHoursTest(unittest.TestCase):
    def test_saturday_is_always_closed(self):
        self.assertFalse(is_forex_market_hours(datetime(2024, 1, 6, 12, 0, tzinfo=timezone.utc)))

    def test_sunday_before_2200_utc_is_closed(self):
        self.assertFalse(is_forex_market_hours(datetime(2024, 1, 7, 21, 59, tzinfo=timezone.utc)))

    def test_sunday_at_2200_utc_is_open(self):
        self.assertTrue(is_forex_market_hours(datetime(2024, 1, 7, 22, 0, tzinfo=timezone.utc)))

    def test_friday_before_2200_utc_is_open(self):
        self.assertTrue(is_forex_market_hours(datetime(2024, 1, 5, 21, 59, tzinfo=timezone.utc)))

    def test_friday_at_2200_utc_is_closed(self):
        self.assertFalse(is_forex_market_hours(datetime(2024, 1, 5, 22, 0, tzinfo=timezone.utc)))

    def test_a_weekday_noon_is_open(self):
        self.assertTrue(is_forex_market_hours(datetime(2024, 1, 3, 12, 0, tzinfo=timezone.utc)))


class HealthStatusTest(unittest.TestCase):
    """Bridge.health_status() backs mt5/Dockerfile's /healthz - it must only
    flag an outage when the market is open and ticks have actually stopped."""

    def make_bridge(self):
        return Bridge(FakeMt5(), 1, "p", "s", "XAUUSD")

    def test_healthy_when_market_closed_even_with_no_tick_ever(self):
        b = self.make_bridge()
        saturday_noon = datetime(2024, 1, 6, 12, 0, tzinfo=timezone.utc).timestamp()
        ok, _ = b.health_status(now=saturday_noon)
        self.assertTrue(ok)

    def test_unhealthy_when_market_open_and_no_tick_ever(self):
        b = self.make_bridge()
        weekday_noon = datetime(2024, 1, 3, 12, 0, tzinfo=timezone.utc).timestamp()
        ok, body = b.health_status(now=weekday_noon)
        self.assertFalse(ok)
        self.assertIn("no tick", body)

    def test_healthy_when_market_open_and_last_tick_within_60s(self):
        b = self.make_bridge()
        weekday_noon = datetime(2024, 1, 3, 12, 0, tzinfo=timezone.utc).timestamp()
        b.last_tick_at = weekday_noon - 59
        ok, _ = b.health_status(now=weekday_noon)
        self.assertTrue(ok)

    def test_unhealthy_when_market_open_and_last_tick_over_60s_ago(self):
        b = self.make_bridge()
        weekday_noon = datetime(2024, 1, 3, 12, 0, tzinfo=timezone.utc).timestamp()
        b.last_tick_at = weekday_noon - 61
        ok, body = b.health_status(now=weekday_noon)
        self.assertFalse(ok)
        self.assertIn("no tick for", body)


if __name__ == "__main__":
    unittest.main()
