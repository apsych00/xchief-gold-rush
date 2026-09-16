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

import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s [bridge] %(message)s", stream=sys.stdout)
log = logging.getLogger("bridge")

POLL_MS = int(os.environ.get("MT5_POLL_MS", "75"))  # target 50-100 ms between polls
RECONNECT_MIN_S = 1
RECONNECT_MAX_S = 30
PORT = int(os.environ.get("MT5_BRIDGE_PORT", "8765"))


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

            tick = self.mt5.symbol_info_tick(self.symbol)
            if tick is None:
                log.warning("symbol_info_tick returned None; terminal likely dropped")
                await self.set_connected(False)
                self.mt5.shutdown()
                continue

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
            await self.poll_loop()


def main():
    login = int(os.environ["MT5_LOGIN"])
    password = os.environ["MT5_PASSWORD"]
    server = os.environ["MT5_SERVER"]
    symbol = os.environ.get("MT5_SYMBOL", "XAUUSD")

    import MetaTrader5 as mt5  # Windows-only package; loaded here, not at module scope

    bridge = Bridge(mt5, login, password, server, symbol)
    asyncio.run(bridge.run())


if __name__ == "__main__":
    main()
