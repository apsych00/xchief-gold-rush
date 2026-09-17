# B15 harden: making the MT5 Docker bridge battle-tested

Branch `nightmareinc/b15-review`. Follows on from `docs/reports/b15-review.md` (the independent review, ranked fix list). Everything below was run against a real pull of the base image on this machine (`gmag11/metatrader5_vnc@sha256:2fdff449cf70b74c242319828b6859592ab52dfb05690d9a989c75107dabf4c1`, 6.71GB, already cached locally).

## Bad news first

The orchestrator's KNOWN BLOCKER description was right that `RUN wine python -m pip install` cannot work at build time, but the prescribed fix - "wait for terminal64.exe and python.exe, then `wine <python> -m pip install MetaTrader5 websockets` once" - was not sufficient on its own. Getting `docker compose --profile mt5 up` to actually stay up and report a real bridge status took four more real bugs, found by running the container against the real base image, not by reasoning about it:

1. **The base image strips the process environment before running Docker's CMD.** A plain `#!/bin/bash` entrypoint runs with `WINEPREFIX` and `XDG_RUNTIME_DIR` both unset - `wine` silently created a throwaway prefix at `/root/.wine` instead of reusing `/config/.wine` (the persisted volume, where the base image's own install actually lives). Every script in this base image uses `#!/usr/bin/with-contenv bash` for exactly this reason; `mt5/entrypoint.sh` now does too.
2. **`/config/.wine` is owned by `abc` (uid 911), not root.** Docker's CMD runs as root (confirmed against `/package/admin/s6-overlay-*/etc/s6-linux-init/skel/rc.init` in the pulled image - see "Item 4" below). `wine` refuses to touch a prefix it doesn't own ("`/config/.wine' is not owned by you`"). Fixed by running wine as `abc` via `s6-setuidgid`, the same tool every other script in this image uses.
3. **The base image's own Python install does not include pip.** `start.sh`'s `/quiet` install of `python-3.9.13.exe` leaves `python -m pip` failing with "No module named pip." Fixed by running `python -m ensurepip --upgrade` (a stdlib module bundled with every CPython install) before the real pip install.
4. **The MetaTrader5 wheel is ABI-incompatible with numpy 2.x.** MetaTrader5 only declares `numpy>=1.7`, so an unconstrained install pulls current numpy (2.0.2) and the package's compiled `_core` extension fails to import (`AttributeError: _ARRAY_API not found`). Fixed by pinning `numpy<2` in the same install command.
5. **`/root` is mode 0700 - root only.** `bridge.py` ran as `abc` (fix 2) but lived at `/root/bridge.py`, so `abc` got `Permission denied` reading its own script. Moved to `/opt/mt5-bridge/bridge.py`, world-readable.

All five are fixed in `mt5/entrypoint.sh` and `mt5/Dockerfile`. Proof, end to end, is in "Proving it" below: `docker compose --profile mt5 up` now builds, boots, waits out the base image's own MT5/Wine/Python install, installs the bridge's own dependencies exactly once (marked on the persisted volume), starts `bridge.py`, and stays up - reporting `connected: false` over the WebSocket with no real credentials, exactly as the ticket asked.

## Ranked fix list (from b15-review.md)

1. **Move the pip install off build-time `RUN` onto a runtime hook.** Fixed - `mt5/entrypoint.sh`, plus the four additional runtime bugs above that the naive version of this fix did not survive.
2. **Add a named volume over the Wine profile/MT5 data directory.** Fixed - `mt5_data:/config` in `docker-compose.yml`. Also now the mechanism that makes restarts (and the fix-forward loop above) fast: once installed, a full container recreate reaches `bridge.py` in ~10s instead of ~13 minutes.
3. **Pin the base image to a digest, not `latest`.** Fixed - `mt5/Dockerfile` now pins `gmag11/metatrader5_vnc@sha256:2fdff449cf70b74c242319828b6859592ab52dfb05690d9a989c75107dabf4c1`, the exact digest pulled and tested here.
4. **Confirm whether the base image's boot sequence still runs under the CMD override.** Investigated directly against the pulled image, not assumed either way - see "Judgment call: item 4" below. Short version: the base image's own boot sequence is untouched (CMD does not replace it), but the review's underlying worry - that this container's lifetime is coupled to the bridge process - turned out to be true for a different reason than it guessed.
5. **Add VNC access env vars; document the first-login step.** Fixed - `CUSTOM_USER`/`PASSWORD` added to `.env.box.example` (confirmed against `init-nginx/run` in the pulled image: these gate KasmVNC's web UI, port 3001/3000, via `PASSWORD`'s presence). First-login procedure written up in `docs/mt5-feed.md` ("Bridge route" -> "First login").
6. **Add a healthcheck.** Fixed - `mt5/bridge.py` now serves `/healthz` on a separate port (8766); `docker-compose.yml`'s healthcheck curls it. Unhealthy only when the market is open and no tick has landed in 60s (`is_forex_market_hours`, tested in `test/mt5/test_bridge.py`) - a quiet weekend is not a bridge failure.
7. **Wrap the tick-fetch body in a broad exception guard.** Fixed - `mt5/bridge.py`'s `poll_loop()`.
8. **Start the backoff clock at the moment the terminal is judged lost.** Fixed - same block, `await asyncio.sleep(RECONNECT_MIN_S)` before the next reconnect attempt.
9. **Set a memory/CPU limit.** Fixed - see "Memory and CPU limits" below for how the numbers were chosen.
10. **Add unit tests for `sourceDefs()`'s `mt5BridgeWs` branch and MetaApi-wins precedence.** Fixed - three new tests in `test/unit/feed.test.mjs`.

## Judgment call: item 4 (CMD vs. the base image's own supervisor)

The review's worry was reasonable but not quite what's actually happening. Traced through the pulled image's own scripts (not assumed):

- The base image is `linuxserver.io`'s s6-overlay v3 pattern: `ENTRYPOINT ["/init"]`, untouched by this Dockerfile. `/init` -> `preinit` -> `stage0` -> `s6-linux-init`'s generated `stage1`/`stage2`.
- `stage2` (`/package/admin/s6-overlay-*/etc/s6-linux-init/skel/rc.init` in the pulled image) runs `s6-rc -u -- change "$top"` to bring up every base-image service (Xvfb/KasmVNC, openbox, nginx, ...) - including the openbox autostart that runs `/Metatrader/start.sh`, the script that installs Mono, the MT5 terminal and Wine's own Python. **This part of the review's guess was right**: none of that waits for our CMD, and none of our CMD's presence changes whether it runs.
- **What's different from the review's guess**: once the bundle is up, that same `rc.init` runs Docker's CMD *directly as its own foreground child* (`$arg0 "$@"`) - not as a fire-and-forget legacy service. When that child exits, `rc.init` execs `/run/s6/basedir/bin/halt`, ending the whole container. So the review's instinct that the container's lifetime is coupled to CMD in some way was correct - it just isn't a "one replaces the other" story, it's "the container equals however long CMD stays alive," full stop.
- This raises the stakes on item 7 (the exception guard) well past what the review's own writeup implied: a `bridge.py` crash from an unhandled exception does not just drop the bridge's own clients and force a terminal relogin (the review's framing) - it takes the *entire container* down, replaying the ~13-minute cold-boot install every time (mitigated only by the fact that `/config` is persisted, so a warm restart replays in ~10s instead - but that 10s still means every X11/KasmVNC/openbox session and the MT5 terminal itself restart from scratch on every crash). `entrypoint.sh` was written with this in mind: `set -e` is deliberately not used, and every install step logs and continues rather than exiting on failure, so a transient install hiccup degrades to "retry on the next start" rather than compounding into a fast restart loop (which is exactly what happened during testing before this was fixed - see "Proving it").

## Memory and CPU limits

Measured with `docker stats` against the real pulled image during the install phase (Mono + MT5 installer downloading, Xvfb/KasmVNC/openbox running, wine active): climbing from 121MiB to 344MiB over the first minute, CPU spiking to ~120% briefly during installer extraction. That's before the MT5 terminal and `bridge.py` are both live simultaneously - the review's own citation of community reports for this class of image (Wine + Xvfb + MT5 terminal + a Python process) puts steady-state full load at 1-2GB. `docker-compose.yml` sets `cpus: '1.5'`, `memory: 2048M` - enough headroom over both the measured install-phase number and the community steady-state estimate to avoid being the noisy neighbor on a box that also runs Postgres, the game server and Caddy, without being so generous it defeats the point of a limit.

## Failure drills

Each run locally with fakes, no real terminal or credentials. Full driver scripts are not kept in the repo (they were one-off harnesses against the real `Bridge` class and the real `server/feed.js`/`feed-mt5-bridge.js`, not permanent tests); the log lines below are pasted from the actual runs.

### Terminal restart

Drove `mt5/bridge.py`'s real `Bridge`/`connect_terminal` against a scripted fake `mt5` module: two good ticks, then `symbol_info_tick` returns `None` (terminal drops), then a successful reconnect.

```
2026-09-17 10:16:20,019 [bridge] terminal connected=True
  [drill] published tick: {'price': 4355.200000000001, 'bid': 4355.1, 'ask': 4355.3, 't': 1}
  [drill] published tick: {'price': 4355.299999999999, 'bid': 4355.2, 'ask': 4355.4, 't': 2}
2026-09-17 10:16:20,019 [bridge] terminal connected=False
2026-09-17 10:16:20,019 [bridge] terminal connected=True
  [drill] published tick: {'price': 4356.1, 'bid': 4356.0, 'ask': 4356.2, 't': 3}
```

Connection state flips cleanly on the drop and the reconnect; no exception, no duplicate publish of the pre-drop price.

### Wrong symbol

`symbol_select()` scripted to always fail:

```
2026-09-17 10:16:20,019 [bridge] symbol_select(XAUUSD) failed: (0, 'scripted failure')
2026-09-17 10:16:20,019 [bridge] symbol_select(XAUUSD) failed: (0, 'scripted failure')
2026-09-17 10:16:20,019 [bridge] symbol_select(XAUUSD) failed: (0, 'scripted failure')
```

### Wrong password

`login()` scripted to always fail:

```
2026-09-17 10:16:20,019 [bridge] login() failed: (0, 'scripted failure')
2026-09-17 10:16:20,020 [bridge] login() failed: (0, 'scripted failure')
2026-09-17 10:16:20,020 [bridge] login() failed: (0, 'scripted failure')
```

Wrong symbol and wrong password log distinguishably different messages (matches b15-review.md's note that these look identical in the current build - they now don't, at the log-line level, even though the boolean outcome is the same).

### Bridge restart while the game server is connected

Drove the real `createFeed()` (`server/feed.js`) against a fake local WebSocket server standing in for `mt5/bridge.py`, `mt5BridgeWs` pointed at it, `finnhubToken` unset so `okx`/`binance` are the real always-on fallbacks:

```
[drill] --- phase 1: mt5 ticking, server should stay on mt5 ---
[drill] PUBLISHED {"price":4360.409,...}
[drill] status(): {"mt5":{"connected":true,...},"okx":{"connected":false,...},"binance":{"connected":false,...}}
[drill] latest(): {"price":4360.266,"source":"mt5","quiet":false}

[drill] --- phase 2: kill the fake bridge (simulates bridge restart) ---
[feed] upstream mt5 failed: 
[feed] upstream mt5 failed: 
[feed] upstream mt5 failed: 
[drill] status() after 11s of mt5 silence: {"mt5":{"connected":false,...},"okx":{"connected":true,...},"binance":{"connected":true,...}}
[drill] latest() after demotion: {"price":4360.266,"source":"okx","quiet":false}
[drill] elapsed since bridge died: 11012ms

[drill] --- phase 3: bridge restarts, ticks resume ---
[drill] mt5 reconnected after restart: true
[drill] status() after mt5 resumes: {"mt5":{"connected":true,...},"okx":{"connected":true,...},"binance":{"connected":true,...}}
[drill] latest() after mt5 resumes: {"price":4360.469,"source":"mt5","quiet":false}
```

Demotion happened at 11.0s of mt5 silence (within the 10s rule's tolerance for the drill's own polling granularity), the published price never jumped at either switch (4360.266 held across the mt5-\>okx handover), mt5 reconnected on its own backoff schedule once the bridge came back, and the series settled back onto mt5 with no jump there either.

## Proving it

`docker compose --profile mt5 up`, real pulled base image, fake credentials (`MT5_LOGIN=12345`, `MT5_PASSWORD=fake-investor-pw`, `MT5_SERVER=Fake-Server`):

```
2026-09-17T06:37:59Z [entrypoint] found terminal at: /config/.wine/drive_c/Program Files/MetaTrader 5/terminal64.exe
2026-09-17T06:37:59Z [entrypoint] found Wine Python at: /config/.wine/drive_c/Program Files (x86)/Python39-32/python.exe
2026-09-17T06:37:59Z [entrypoint] MetaTrader5 + websockets already installed (/config/.mt5-bridge-deps-installed exists) - skipping.
2026-09-17T06:37:59Z [entrypoint] starting bridge.py...
2026-09-17 06:38:03,864 [bridge] server listening on 0.0.0.0:8765
2026-09-17 06:38:03,864 [bridge] bridge listening on :8765
2026-09-17 06:38:03,874 [bridge] healthz listening on :8766
```

Container stayed `Up` continuously afterward (checked repeatedly over several minutes, no restarts). Connecting a WebSocket client from inside the compose network to `mt5:8765` (no credentials needed, per the ticket):

```
MSG: {"type": "status", "connected": false}
```

`/healthz`, same run, real UTC weekday (market open, no real terminal login so no ticks ever land):

```
$ curl -s http://localhost:8766/healthz -w '\nHTTP_STATUS:%{http_code}\n'
no tick received yet
HTTP_STATUS:503
```

Correct: unhealthy because the market is open and no tick has ever landed (there's no real investor login in this test), not because of a bug. `initialize()` on the fake credentials fails with `(-10005, 'IPC timeout')` - consistent with the terminal being logged in as garbage and/or sitting at a first-run dialog nobody has clicked through yet (docs/mt5-feed.md "First login"), exactly the state the ticket asked this to survive without crashing.

One thing this run caught that's worth recording: the very first attempt at this (before the `s6-setuidgid`/`ensurepip`/`numpy<2` fixes above) genuinely fast-restart-looped the whole container every 6-19 seconds - each cycle got far enough to attempt the pip install, fail, start `bridge.py` anyway, hit `ModuleNotFoundError` on `import MetaTrader5`, exit, and get recreated by `restart: unless-stopped`. That failure mode is real, it's the reason item 4's nuance above matters, and it's what the four extra fixes in "Bad news first" close off.

## Second pass

Everything above ("Bad news first" through "Proving it") is the first hardening pass. It made the container survive install-time crashes, but the fake numeric credentials in "Proving it" (`MT5_LOGIN=12345`) hid a bug that only shows up with the real empty credentials this box will actually run with, and a live retest surfaced a second, more serious bug in the readiness gate itself. Both are fixed here. **The "Proving it" run above is real (that build genuinely stayed up), but its readiness design and its choice of credentials no longer represent what ships - this section supersedes it.**

### Bad news: the chosen readiness signal cannot ever fire

The first pass's readiness check (`mt5/entrypoint.sh`) waited for three things before touching Wine's Python: the MT5 terminal executable, a Wine-side `python.exe`, and start.sh's own step 7 (`[7/7] Starting the mt5linux server...`) opening port 8001 - on the theory that step 7 only runs after every earlier step, including step 6's pip installs, has returned.

Retesting against a real container left running for over an hour (`b15v2-mt5-1`, unhealthy the whole time) showed that theory was half right and half wrong. Confirmed directly by pulling `/Metatrader/start.sh` out of the running container and by exec'ing into it:

- Step 7 genuinely only runs after step 6 returns - that part holds.
- Step 7 itself is broken on this base image's pinned digest. `python3 -m mt5linux --host 0.0.0.0 -p 8001 ...` fails on the Linux side with:
  ```
  File "/config/.local/lib/python3.11/site-packages/mt5linux/metatrader5.py", line 1755
      code = f'mt5.copy_rates_from("{symbol}", {timeframe}, {
             ^
  SyntaxError: unterminated string literal (detected at line 1755)
  [7/7] Failed to start the mt5linux server on port 8001.
  ```
  A nested f-string in `mt5linux`'s own bundled code that this image's Linux-side Python 3.11 rejects. start.sh logs the failure and moves on without exiting (so the container itself never crashes), but the port never opens - so a readiness check gated on it waits forever. `b15v2-mt5-1` sat on `still waiting ... start.sh step 7 (mt5linux :8001) done: no` for the full hour it was left running, even though everything our own bridge actually needs was already sitting on disk:
  ```
  $ docker exec -u abc b15v2-mt5-1 wine ".../Python39-32/python.exe" -c "import encodings, sys; print(sys.version)"
  3.9.13 (tags/v3.9.13:6de2ca5, May 17 2022, 16:24:45) [MSC v.1929 32 bit (Intel)]
  $ docker exec b15v2-mt5-1 sh -c "ls '.../Python39-32/Lib/site-packages/' | grep -i metatrader"
  MetaTrader5
  MetaTrader5-5.0.36.dist-info
  ```

We don't use the mt5linux server at all (`bridge.py` imports `MetaTrader5` in-process under Wine, not over rpyc), so this dependency was never load-bearing - it was only ever meant as a proxy for "step 6 is done," and it's an unreliable one on this digest.

### Fix: stop depending on step 7, wait on step 6's actual output instead

`mt5/entrypoint.sh`'s wait loop no longer touches port 8001. It now waits for the Wine interpreter to import cleanly (`import encodings` - proof it isn't mid-unpack, the original first-pass bug) and for `MetaTrader5-*.dist-info` to exist under Wine's site-packages (proof start.sh's step 6 already ran `pip install MetaTrader5==5.0.36` there) - both true only once step 6 has actually returned, regardless of whether step 7 ever succeeds. `import MetaTrader5` itself is deliberately not the check: it's expected to fail at this point with `AttributeError: _ARRAY_API not found` (unconstrained numpy 2.x - confirmed the same way against the stuck container) until this script's own `numpy<2` pin runs, so gating readiness on it would be circular.

### Second bug the addendum caught: real credentials aren't what ships

The ADDENDUM to this ticket was right: `.env.box.example` ships with `MT5_LOGIN`/`MT5_PASSWORD`/`MT5_SERVER` all empty, and `bridge.py`'s `main()` did `int(os.environ["MT5_LOGIN"])` unconditionally - a `ValueError` on an empty string, on every single start, until an admin delivers real credentials. The first pass's "Proving it" run never caught this because it used fake numeric credentials instead of the example file.

Fixed in `mt5/bridge.py`: `main()` now checks `credentials_missing(login, password, server)` first. When any of the three is empty, it logs one line and calls `run_idle()` instead of touching `MetaTrader5` or `int()` at all - `run_idle()` serves `{"type":"status","connected":false,"reason":"no_credentials"}` to every WebSocket client on 8765 and a 503 with body `no credentials configured` on `/healthz`, and blocks forever on an `asyncio.Event` that is never set (never exits, matching the supervised-loop contract the rest of `entrypoint.sh` already assumes). Four new unit tests in `test/mt5/test_bridge.py` (`CredentialsMissingTest`, `IdleModeContentTest`) cover the empty-string cases for each of the three vars and the exact status/health payloads.

### Proof: a real clean run, with the example env this time

Ran end to end against the real pulled base image, fresh volume, project `b15v2`, env copied verbatim from `.env.box.example` (a throwaway file, `.env.box.harden-proof`, deleted after the run - `MT5_LOGIN`/`MT5_PASSWORD`/`MT5_SERVER` all empty as shipped, `FINNHUB_TOKEN` never set; `POSTGRES_PASSWORD`/`DOZZLE_PASSWORD_HASH` filled with clearly-fake placeholders only because compose validates the whole file even though just the `mt5` service was started):

```
docker compose -p b15v2 --env-file .env.box.harden-proof --profile mt5 up -d --build mt5
```

**Cold boot**, first log lines (2026-09-17T08:53:10Z, container just started) through the moment `/healthz` first answered (2026-09-17T09:03:36Z - 10m26s, all of it the base image's own Mono/MT5/Python download-and-install, not our code):

```
[migrations] started
[migrations] no migrations found
usermod: no changes
───────────────────────────────────────
  _____ __ __ _____ _____ _____ _____ 
 |     |  |  |   __|_   _|     |     |
...
```
```
2026-09-17T09:03:11Z [entrypoint] install done.
2026-09-17T09:03:11Z [entrypoint] starting bridge.py under supervision (this script never exits; only 'docker stop' does)...
```

`bridge.py`'s own log (`/tmp/mt5-bridge-log.*` inside the container - the entrypoint only surfaces this to `docker logs` on a crash, so it's read separately here):

```
2026-09-17 09:03:12,738 [bridge] MT5_LOGIN/MT5_PASSWORD/MT5_SERVER not fully set - running idle until credentials are delivered
2026-09-17 09:03:13,196 [bridge] server listening on 0.0.0.0:8765
2026-09-17 09:03:13,196 [bridge] bridge listening on :8765 (idle: no credentials configured)
2026-09-17 09:03:13,199 [bridge] healthz listening on :8766 (idle: no credentials configured)
```

`/healthz`:

```
$ curl -s http://localhost:8766/healthz -w '\nHTTP_STATUS:%{http_code}\n'
no credentials configured
HTTP_STATUS:503
```

A throwaway client on the compose network confirms the WebSocket status message:

```
$ docker run --rm --network b15v2_default python:3.12-slim sh -c "pip install -q websockets; python3 -c '...connect ws://mt5:8765, print first message...'"
{"type": "status", "connected": false, "reason": "no_credentials"}
```

**Warm restart** (`docker restart b15v2-mt5-1`, marker + Wine packages already on the persisted volume):

```
2026-09-17T09:05:04Z  (docker restart issued)
2026-09-17T09:05:09Z  healthz_http=000  (container still coming back up)
2026-09-17T09:05:15Z  healthz_http=503  (healthy state reached again - ~11s)
```

```
2026-09-17 09:05:13,248 [bridge] MT5_LOGIN/MT5_PASSWORD/MT5_SERVER not fully set - running idle until credentials are delivered
2026-09-17 09:05:13,638 [bridge] server listening on 0.0.0.0:8765
2026-09-17 09:05:13,638 [bridge] bridge listening on :8765 (idle: no credentials configured)
2026-09-17 09:05:13,648 [bridge] healthz listening on :8766 (idle: no credentials configured)
```

`docker inspect` after the restart: `running restarts=0` - a clean `docker restart`, not a crash-restart-loop.

**Teardown**:

```
docker compose -p b15v2 --env-file .env.box.harden-proof --profile mt5 down -v
```

Container, network and the `mt5_data` volume all removed; the throwaway env file was deleted immediately after.

### Files touched (second pass, in addition to the first-pass list above)

- `mt5/entrypoint.sh` - dropped the port-8001 wait, replaced it with the Wine-interpreter-import + MetaTrader5-dist-info check; comments rewritten to describe both bugs and why the new signal is the right one.
- `mt5/bridge.py` - `credentials_missing()`, `run_idle()`, `idle_handler()`, `idle_health_handler()`, `IDLE_STATUS`, `IDLE_HEALTH_BODY`; `main()` now checks credentials before touching `int()` or `MetaTrader5`.
- `test/mt5/test_bridge.py` - `CredentialsMissingTest` (4 cases) and `IdleModeContentTest` (2 cases).
- `docs/reports/b15-harden.md` - this section. (`docs/mt5-feed.md`'s "If the bridge never starts" already pointed here from the first pass; not touched again this pass.)

## Gate outputs

### `npm run lint`

```
> xchief-gold-rush@1.1.0 lint
> eslint .

(exit 0, no output)
```

### `npm run test:unit`

```
> xchief-gold-rush@1.1.0 test:unit
> node --test "test/unit/*.test.mjs"
...
ℹ tests 77
ℹ suites 0
ℹ pass 77
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
(exit 0)
```

### Python tests (`python -m pytest test/mt5 -q`, second pass, includes the new idle-mode tests)

```
............................                                             [100%]
28 passed in 0.08s
```

### `docker build mt5/`

```
docker build -f mt5/Dockerfile -t mt5-bridge-test .
...
#10 exporting to image
#10 naming to docker.io/library/mt5-bridge-test:latest done
(exit 0)
```

The KNOWN BLOCKER (`RUN wine python -m pip install` failing at build time) is gone: there is no `RUN` touching Wine at all anymore, so nothing in the image build depends on Wine's runtime-provisioned Python existing.

### `docker compose --profile mt5 config`

Exit 0, full resolved config printed (mt5 service: build context, `mt5_data:/config` volume, healthcheck against `:8766/healthz`, `deploy.resources.limits` at `cpus: 1.5`/`memory: 2048M`, `127.0.0.1:3001` VNC port, `json-file` logging with rotation, all env vars from `.env.box` resolved).

## Files touched

- `mt5/Dockerfile` - pinned digest, dropped the build-time `RUN`, added `entrypoint.sh` + `bridge.py` at their new locations, permissions.
- `mt5/entrypoint.sh` - new. Runtime wait/install/handoff wrapper; the five fixes in "Bad news first" all live here.
- `mt5/bridge.py` - exception guard + backoff-clock fix (items 7, 8), `/healthz` (item 6) with `is_forex_market_hours()`.
- `docker-compose.yml` - `mt5_data` volume (item 2), healthcheck (item 6), `deploy.resources.limits` (item 9), `logging` rotation, `127.0.0.1:3001` VNC port (item 5).
- `.env.box.example` - `CUSTOM_USER`/`PASSWORD` for KasmVNC (item 5).
- `docs/mt5-feed.md` - "Bridge route" -> "First login" procedure (ticket step 3).
- `test/unit/feed.test.mjs` - three new tests for the `mt5BridgeWs` branch and MetaApi-wins precedence (item 10).
- `test/mt5/test_bridge.py` - tests for `is_forex_market_hours()` and `Bridge.health_status()`.
- `docs/reports/b15-harden.md` - this report.
