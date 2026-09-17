"""MT5 tick bridge (docs/mt5-feed.md, "Bridge route"): polls the MetaTrader 5
terminal running under Wine in this container and republishes ticks over a
WebSocket the game server subscribes to (server/feed-mt5-bridge.js).

The MetaTrader5 pip package only works next to a running terminal, so it is
imported lazily in main() rather than at module scope. Everything else here
(make_tick_message, is_duplicate, connect_terminal, Bridge) takes an
injected mt5 module and is exercised in test/mt5/test_bridge.py with a fake
one - no real terminal needed to test it.
"""

import asyncio
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone

import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s [bridge] %(message)s", stream=sys.stdout)
log = logging.getLogger("bridge")

POLL_MS = int(os.environ.get("MT5_POLL_MS", "75"))  # target 50-100 ms between polls
RECONNECT_MIN_S = 1
RECONNECT_MAX_S = 30
PORT = int(os.environ.get("MT5_BRIDGE_PORT", "8765"))
HEALTH_PORT = int(os.environ.get("MT5_BRIDGE_HEALTH_PORT", "8766"))
HEALTH_STALE_S = int(os.environ.get("MT5_HEALTH_STALE_S", "60"))


def is_forex_market_hours(dt_utc):
    """True when the forex market is conventionally open: Sun 22:00 UTC
    (Sydney open) through Fri 22:00 UTC (New York close). Used only to decide
    whether a tick gap is a real outage (market open, no ticks: unhealthy) or
    expected silence (weekend: healthy regardless of tick age)."""
    wd = dt_utc.weekday()  # Mon=0 .. Sun=6
    if wd == 5:  # Saturday: always closed
        return False
    if wd == 6 and dt_utc.hour < 22:  # Sunday before the Sydney open
        return False
    if wd == 4 and dt_utc.hour >= 22:  # Friday after the New York close
        return False
    return True


def make_tick_message(tick):
    """Build the {"price","bid","ask","t"} payload from an MT5 tick object
    (needs only .bid, .ask and .time_msc, falling back to .time in seconds)."""
    bid = float(tick.bid)
    ask = float(tick.ask)
    t_msc = getattr(tick, "time_msc", None)
    t = int(t_msc) if t_msc else int(float(tick.time) * 1000)
    return {"price": (bid + ask) / 2, "bid": bid, "ask": ask, "t": t}


def is_duplicate(prev, cur):
    """True when this tick carries no new information over the last published one."""
    if prev is None:
        return False
    return prev["bid"] == cur["bid"] and prev["ask"] == cur["ask"] and prev["t"] == cur["t"]


def connect_terminal(mt5, login, password, server, symbol):
    """Log in with the investor credentials and select the symbol. Returns True on success."""
    if not mt5.initialize():
        log.warning("initialize() failed: %s", mt5.last_error())
        return False
    if not mt5.login(login, password=password, server=server):
        log.warning("login() failed: %s", mt5.last_error())
        mt5.shutdown()
        return False
    if not mt5.symbol_select(symbol, True):
        log.warning("symbol_select(%s) failed: %s", symbol, mt5.last_error())
        mt5.shutdown()
        return False
    return True


class Bridge:
    """Owns the terminal connection, the poll loop and the WebSocket server.
    Takes an injected mt5 module so it never imports MetaTrader5 itself."""

    def __init__(self, mt5, login, password, server, symbol, port=PORT, poll_ms=POLL_MS):
        self.mt5 = mt5
        self.login = login
        self.password = password
        self.server = server
        self.symbol = symbol
        self.port = port
        self.poll_s = poll_ms / 1000
        self.clients = set()
        self.connected = False
        self.last_tick = None
        self.last_tick_at = None  # time.time() of the last successful poll (dup or not); drives /healthz

    async def broadcast(self, payload):
        if not self.clients:
            return
        msg = json.dumps(payload)
        await asyncio.gather(*(c.send(msg) for c in list(self.clients)), return_exceptions=True)

    async def set_connected(self, connected):
        if connected == self.connected:
            return
        self.connected = connected
        log.info("terminal connected=%s", connected)
        await self.broadcast({"type": "status", "connected": connected})

    def health_status(self, now=None):
        """(ok, body) for /healthz: unhealthy only when the market is open and
        no successful poll has landed in HEALTH_STALE_S - a quiet weekend
        market is not a bridge failure."""
        now = time.time() if now is None else now
        dt_utc = datetime.fromtimestamp(now, tz=timezone.utc)
        if not is_forex_market_hours(dt_utc):
            return True, "ok: market closed"
        if self.last_tick_at is None:
            return False, "no tick received yet"
        age = now - self.last_tick_at
        if age > HEALTH_STALE_S:
            return False, f"no tick for {age:.1f}s (market open)"
        return True, f"ok: last tick {age:.1f}s ago"

    async def health_handler(self, reader, writer):
        try:
            await reader.readline()  # request line only; headers are ignored
            while True:
                line = await reader.readline()
                if not line or line in (b"\r\n", b"\n"):
                    break
            ok, body = self.health_status()
            status = "200 OK" if ok else "503 Service Unavailable"
            payload = body.encode()
            writer.write(
                f"HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {len(payload)}\r\nConnection: close\r\n\r\n".encode()
                + payload
            )
            await writer.drain()
        finally:
            writer.close()

    async def poll_loop(self):
        attempt = 0
        while True:
            if not self.connected:
                ok = connect_terminal(self.mt5, self.login, self.password, self.server, self.symbol)
                if not ok:
                    delay = min(RECONNECT_MAX_S, RECONNECT_MIN_S * 2 ** min(attempt, 5))
                    attempt += 1
                    await asyncio.sleep(delay)
                    continue
                attempt = 0
                await self.set_connected(True)

            try:
                tick = self.mt5.symbol_info_tick(self.symbol)
            except Exception as err:  # a Wine/DLL hiccup must degrade to a reconnect, not kill the process
                log.warning("symbol_info_tick() raised: %s", err)
                tick = None

            if tick is None:
                log.warning("symbol_info_tick returned None; terminal likely dropped")
                await self.set_connected(False)
                try:
                    self.mt5.shutdown()
                except Exception as err:
                    log.warning("shutdown() raised while recovering: %s", err)
                # Backoff starts counting from the moment the terminal is judged lost, not only
                # after the first failed connect_terminal() call - otherwise the very next
                # iteration retries with no delay at all (a flaky-but-not-fully-down terminal
                # can hot-loop initialize()/login()).
                attempt = 0
                await asyncio.sleep(RECONNECT_MIN_S)
                continue

            self.last_tick_at = time.time()
            cur = make_tick_message(tick)
            if not is_duplicate(self.last_tick, cur):
                self.last_tick = cur
                await self.broadcast(cur)

            await asyncio.sleep(self.poll_s)

    async def handler(self, websocket):
        self.clients.add(websocket)
        try:
            await websocket.send(json.dumps({"type": "status", "connected": self.connected}))
            async for _ in websocket:
                pass  # the bridge is publish-only; nothing a client sends is read
        finally:
            self.clients.discard(websocket)

    async def run(self):
        async with websockets.serve(self.handler, "0.0.0.0", self.port):
            log.info("bridge listening on :%d", self.port)
            health_server = await asyncio.start_server(self.health_handler, "0.0.0.0", HEALTH_PORT)
            log.info("healthz listening on :%d", HEALTH_PORT)
            async with health_server:
                await self.poll_loop()


def credentials_missing(login, password, server):
    """True when any of MT5_LOGIN/MT5_PASSWORD/MT5_SERVER is unset or empty -
    the state the box is in until the admin delivers real credentials."""
    return not login or not password or not server


IDLE_STATUS = {"type": "status", "connected": False, "reason": "no_credentials"}
IDLE_HEALTH_BODY = b"no credentials configured"


async def idle_handler(websocket):
    """No MT5 credentials: publish-only, like handler(), but always reports
    the same not-connected status - there is no terminal to poll."""
    await websocket.send(json.dumps(IDLE_STATUS))
    async for _ in websocket:
        pass


async def idle_health_handler(reader, writer):
    try:
        await reader.readline()
        while True:
            line = await reader.readline()
            if not line or line in (b"\r\n", b"\n"):
                break
        writer.write(
            f"HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nContent-Length: {len(IDLE_HEALTH_BODY)}\r\nConnection: close\r\n\r\n".encode()
            + IDLE_HEALTH_BODY
        )
        await writer.drain()
    finally:
        writer.close()


async def run_idle(port=PORT, health_port=HEALTH_PORT):
    """Serve the no-credentials status forever instead of exiting - decision 5:
    main() raising on int(os.environ["MT5_LOGIN"]) with an empty string would
    otherwise crash the bridge on every start until credentials are delivered."""
    async with websockets.serve(idle_handler, "0.0.0.0", port):
        log.info("bridge listening on :%d (idle: no credentials configured)", port)
        health_server = await asyncio.start_server(idle_health_handler, "0.0.0.0", health_port)
        log.info("healthz listening on :%d (idle: no credentials configured)", health_port)
        async with health_server:
            await asyncio.Event().wait()


def main():
    login = os.environ.get("MT5_LOGIN", "")
    password = os.environ.get("MT5_PASSWORD", "")
    server = os.environ.get("MT5_SERVER", "")
    symbol = os.environ.get("MT5_SYMBOL", "XAUUSD")

    if credentials_missing(login, password, server):
        log.warning("MT5_LOGIN/MT5_PASSWORD/MT5_SERVER not fully set - running idle until credentials are delivered")
        asyncio.run(run_idle())
        return

    import MetaTrader5 as mt5  # Windows-only package; loaded here, not at module scope

    bridge = Bridge(mt5, int(login), password, server, symbol)
    asyncio.run(bridge.run())


if __name__ == "__main__":
    main()
