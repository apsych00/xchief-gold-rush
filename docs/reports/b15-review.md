# B15 review: MT5 Docker bridge

Branch `nightmareinc/b15-mt5-docker`. Independent review, no fixes applied.

## Bad news first

**`docker build mt5/` fails outright.** It does not just carry unverified risk - it does not produce an image at all. The pull of `gmag11/metatrader5_vnc:latest` took about 36 minutes in this sandbox (large image), and then the build died on its own second line:

```
RUN wine python -m pip install --no-cache-dir MetaTrader5 websockets
...
error: XDG_RUNTIME_DIR is invalid or not set in the environment.
Application could not be started, or no application associated with the specified file.
ShellExecuteEx failed: File not found.
```

`wine` cannot find a `python` to run. That is not an environment quirk of this sandbox - `ShellExecuteEx failed: File not found` is Wine falling back to a file-association lookup because there is no `python` command registered in the Wine prefix at all, which means the base image's Windows-side Python is not present at image-build time. It is installed by the base image's own entrypoint/boot script when the *container* first starts (the same boot sequence that brings up Xvfb and the terminal), not baked into the image layers `FROM` provides. Running `wine python -m pip install ...` as a `RUN` step during `docker build` asks for something that only exists after the base image's runtime boot has happened once - which cannot happen during a build. This Dockerfile cannot work as written; it needs the `MetaTrader5`/`websockets` install moved to a runtime step (after the base image's own startup script has provisioned Wine-side Python), not a build-time `RUN`.

This confirms, with evidence rather than suspicion, the risk the Dockerfile's own comment already flagged: the base image's actual boot contract (what it does before it hands off to `CMD`, and what a "build" versus a "first container start" each provide) was never checked against the real image before this shipped.

## 1. Blockers (fresh Ubuntu 24.04 + Docker box)

- **The image does not build** (see "Bad news first" and the gate output below) - `wine python -m pip install` at build time fails because the base image's Windows-side Python only exists after the base image's own container-runtime boot script has run, not at `docker build` time. Nothing downstream of this matters until the install step moves to a runtime hook.
- **No volume for terminal login state.** `docker-compose.yml`'s `mt5` service declares no volumes. The base image's Wine profile (where MT5 stores its login session, symbol list, and any first-run license acceptance) lives inside the container's writable layer. Every `docker compose up -d --build`, every `restart: unless-stopped` recreate after a host reboot, and every image rebuild throws that state away. `bridge.py`'s reconnect loop can re-`login()` on its own, but a from-scratch MT5 terminal typically needs a first-run license dialog clicked over VNC before it will do anything headless - nothing here does that or documents it as a manual one-time step against a persisted volume.
- **Base image pinned to `latest`, not a digest or version tag.** `mt5/Dockerfile:14`. A tag re-push changes the box's behavior on the next rebuild with no code change to review. `docker build` output (see tail below) does resolve a digest at pull time, but the Dockerfile itself does not pin it, so the next build can silently pull something else.
- **No healthcheck.** `db` in `docker-compose.yml` has one (`pg_isready`); `mt5` has none. Docker has no way to know the Wine/Xvfb/terminal stack came up; `restart: unless-stopped` only reacts to the top-level process (`wine python bridge.py`) dying, not to the terminal inside Wine being stuck (e.g., a stuck first-login dialog).
- **`CMD` replaces the base image's own supervisor, not just adds to it** (`mt5/Dockerfile:28-33`, self-acknowledged in the comment). The `gmag11/metatrader5_vnc` image's whole reason to exist is a boot/keep-alive sequence that restarts `terminal.exe` if it crashes independent of the outer container. Replacing `CMD` with `wine python bridge.py` means if that sequence's own supervisor was meant to run alongside (not instead of) the payload command, this either never launches the terminal at all or launches it once with nothing to restart it if it crashes without taking the whole container down. This is exactly the thing the Dockerfile comment flags as unverified - and it is the actual behavior gate here, not a nice-to-have.
- **VNC credentials unset.** That base image typically expects `CUSTOM_USER`/`PASSWORD` (or similar) env vars to set up VNC access for the first manual login; neither `mt5/Dockerfile` nor `.env.box.example`'s new block sets them. Without documented VNC access, there is no way to do the first-run login/license step at all on a fresh box.
- **Secrets handling is otherwise fine and consistent** with the rest of the box: `MT5_LOGIN`/`MT5_PASSWORD`/`MT5_SERVER` ride in `.env.box` via `env_file`, same pattern as the server's other secrets; nothing is baked into the image or logged (checked `bridge.py`'s log lines - only `mt5.last_error()` and boolean states are logged, never the password).
- **Port 8765 is correctly unpublished** - no `ports:` entry, only reachable inside the compose network as `mt5:8765`. Matches the doc.

## 2. Correctness of the tick path

- **Mid computation** (`mt5/bridge.py:29-36`): `(bid+ask)/2`, matches the project convention stated in `docs/mt5-feed.md`. Correct.
- **De-dup** (`mt5/bridge.py:39-43`): exact-match on bid, ask, and `t`. Reasonable given ticks are polled, not pushed - a genuinely new tick object from the terminal should differ in at least `t`.
- **Timestamps**: `time_msc` preferred, falls back to `time * 1000` when `time_msc` is `0`/`None` (`if t_msc else ...` correctly treats `0` as "absent," covered by the fallback test). Fine.
- **Validation range**: enforced entirely on the JS side (`server/feed-mt5-bridge.js:23-26`, 100..100000 finite price, finite `t`) - `bridge.py` itself performs no range validation before broadcasting. That is an acceptable division of labor (matches the existing MetaApi adapter's pattern) but means a broker-side data glitch (e.g., a zero or negative bid during a feed hiccup) is only caught client-side, one hop later than it could be.
- **Backoff**: 1s..30s exponential on failed `connect_terminal()` (`mt5/bridge.py:97`), same shape as every other source in `server/feed.js`. Correct.
- **Terminal logs out mid-stream** (`symbol_info_tick` returns `None`, `mt5/bridge.py:105-109`): sets `connected=False`, calls `shutdown()`, then `continue`s straight back to the top of the loop with **no sleep**. Since `connected` is now `False`, the very next iteration calls `connect_terminal()` immediately - if `initialize()` happens to succeed trivially (Wine-side handle still alive) but `login()` or `symbol_select()` fails, only then does backoff engage. Between the None-tick detection and the first retry there is no minimum delay at all, so a flaky-but-not-fully-down terminal can hot-loop `initialize()`/`login()` calls. Small but real - the backoff should start counting from the moment the terminal is judged lost, not only after the first failed reconnect attempt.
- **No exception guard around `symbol_info_tick()` / `symbol_select()` calls.** If the ctypes call into the Wine-side DLL raises instead of returning `None` or `False` (plausible for a crashed terminal process, not just a logged-out one), it propagates out of `poll_loop()`, kills the `asyncio.run()` task, and the whole bridge process exits. `restart: unless-stopped` will bring the container back, but every connected server-side client drops and the whole login sequence (with its volume gap above) starts over. A bare `except Exception` around the poll body, treated the same as a `None` tick, would make this the same well-handled path as a graceful logout instead of a process-level crash.
- **Wrong symbol**: `symbol_select()` failure is treated identically to a login failure - logged, shut down, backed off. No distinct signal surfaces this as "symbol is wrong" versus "credentials are wrong"; both look the same in the operator logs beyond the log line text. Not wrong, just harder to diagnose at 3 a.m.
- **No WebSocket clients**: `broadcast()` returns early (`mt5/bridge.py:78-82`) - no wasted work, no error. Correct.
- **Malformed messages** (client side, `server/feed-mt5-bridge.js:59-73`): JSON parse wrapped in try/catch, non-object payloads dropped, `status` messages routed separately, everything else validated before `onTick` fires. Correct and covered by tests.

## 3. Battle-tested practice check

Compared against how `gmag11/metatrader5_vnc` (the base image chosen here) and similar headless-MT5-in-Docker setups are run in practice, per that project's own README and the wider pattern used by comparable images (e.g. `datawise-tech/mt5-terminal`, `arwahop/mt5-linux-docker`):

- **Persisted profile via volume.** The common pattern mounts a volume over the Wine prefix (or the MT5 data folder specifically) so a container recreate does not require a fresh manual login. This build has no volume for the `mt5` service - a real departure, and not a justified one; it is simply missing.
- **VNC for the one-time interactive step, then headless.** These images expose VNC (often with a password env var) specifically so a human clicks through the license/first-login dialog once, after which the terminal runs unattended behind Xvfb. This build sets no VNC credentials and documents no manual first-login step - so even the intended one-time interactive step has nowhere to happen.
- **Wine version pinning.** These images typically pin a tested Wine build inside themselves (that is the value of using the image at all rather than rolling one's own Wine+MT5 setup); this Dockerfile inherits whatever `gmag11/metatrader5_vnc:latest` currently ships, unpinned at the tag level, so "tested Wine version" only holds until the tag moves.
- **A supervisor that restarts the terminal process independent of the container.** Discussed above - this Dockerfile's `CMD` override is the sharpest departure from the base image's own design, and the one flagged by the Dockerfile's own author-comment as unverified.
- **Memory footprint.** Community reports for this class of image run in the 1-2 GB range per instance (Wine + Xvfb + MT5 terminal + a Python process). Nothing in `docker-compose.yml` sets a memory limit or reservation for the `mt5` service; on a box also running Postgres, the game server, and Caddy, an unbounded Wine/MT5 instance is a plausible noisy-neighbor risk worth a limit before this goes on the expo box.

None of these departures look like considered tradeoffs recorded anywhere (no ADR, no note in `docs/mt5-feed.md` explaining why the volume or VNC setup was skipped) - they read as gaps, not decisions.

## 4. Tests

`test/mt5/test_bridge.py` (Python, pure functions) and `test/unit/feed-mt5-bridge.test.mjs` (JS adapter) are both genuine fail-if-wrong tests - they assert concrete outputs (mid price, `t` fallback, exact key set, dedup on each field independently, connect/login/symbol_select call order and short-circuiting, and via the fake WebSocket server, real message parsing, state transitions, and close handling) rather than re-describing the implementation. No test in either file just restates what the code does with no independent expectation.

**Coverage gap, not a bad test: the new branch in `server/feed.js` is untested.** `sourceDefs()` gained an `else if (mt5BridgeWs)` branch and the "MetaApi wins if both configured" precedence (`server/feed.js` diff, `git diff dev...HEAD`). Neither is exercised by any test:

```
$ grep -rn "mt5BridgeWs\|createMt5BridgeSource" test/
test/unit/feed-mt5-bridge.test.mjs   (adapter only, not feed.js's wiring)
```

`test/unit/feed-mt5.test.mjs` still only covers the `metaapiToken`+`metaapiAccountId` path (one of its own test names is literally "mt5 exists in status() only when both metaapiToken and metaapiAccountId are set" - true of the old code, silently incomplete now that a second way to get an `mt5` source exists). Nothing tests: `mt5BridgeWs` alone produces an `mt5` source, `mt5BridgeWs` is ignored when both MetaApi vars are also set (the stated precedence), or that the bridge-backed source runs through `ingest()` identically to the MetaApi one (priority, 10 s demotion, continuity offset). The adapter itself is well tested in isolation; the wiring that makes it reachable in production is not tested at all.

## 5. Ranked fix list (for the hardening ticket)

1. Move the `MetaTrader5`/`websockets` pip install off a build-time `RUN` in `mt5/Dockerfile:21` onto a runtime hook that fires after the base image's own boot script has provisioned Wine-side Python - the image cannot build as written.
2. Add a named volume over the Wine profile / MT5 data directory in the `mt5` service, `docker-compose.yml` - without it nothing here survives a restart.
3. Pin `mt5/Dockerfile:14`'s `FROM` to a digest or specific version tag, not `latest`.
4. Confirm whether the base image's boot sequence still runs under this `CMD` override, `mt5/Dockerfile:33` - if not, restore its entrypoint/supervisor and append the bridge instead of replacing `CMD`.
5. Add VNC access env vars (whatever `gmag11/metatrader5_vnc` expects) to `mt5/Dockerfile` / `.env.box.example`, and document the one-time manual first-login step against the new persisted volume.
6. Add a `healthcheck:` to the `mt5` service in `docker-compose.yml`, mirroring `db`'s pattern.
7. Wrap the tick-fetch body of `poll_loop()` in `mt5/bridge.py:104-109` with a broad exception guard that treats a raised error the same as a `None` tick, so a Wine/DLL hiccup degrades to a reconnect instead of killing the process.
8. Start the backoff clock at the moment a terminal is judged lost (the `None`-tick branch, `mt5/bridge.py:105-109`), not only after the first failed `connect_terminal()` call, to remove the no-delay hot-loop window.
9. Set a memory limit/reservation on the `mt5` service in `docker-compose.yml`.
10. Add unit tests in `test/unit/feed.test.mjs` (or a new file) for `sourceDefs()`'s `mt5BridgeWs` branch and the MetaApi-wins precedence in `server/feed.js`.

## Gate output

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
ℹ tests 74
ℹ suites 0
ℹ pass 74
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 491.04
(exit 0)
```

### `docker build mt5/`

Base image pull took ~36 minutes in this sandbox - that cost is not documented anywhere in `docs/mt5-feed.md`, and whatever pulls this cold on the expo box should budget for it. The build then fails:

```
#6 [2/4] WORKDIR /root
#6 DONE 1.9s

#7 [3/4] RUN wine python -m pip install --no-cache-dir MetaTrader5 websockets
#7 0.563 wine: created the configuration directory '/config/.wine'
#7 1.761 error: XDG_RUNTIME_DIR is invalid or not set in the environment.
#7 1.768 error: XDG_RUNTIME_DIR is invalid or not set in the environment.
#7 15.52 Application could not be started, or no application associated with the specified file.
#7 15.52 ShellExecuteEx failed: File not found.
#7 ERROR: process "/bin/sh -c wine python -m pip install --no-cache-dir MetaTrader5 websockets" did not complete successfully: exit code: 1
------
Dockerfile:21
--------------------
  19 |     # terminal loads), so it has to go into the base image's Wine-side Python,
  20 |     # not any Linux-side one. `websockets` rides along for bridge.py's server.
  21 | >>> RUN wine python -m pip install --no-cache-dir MetaTrader5 websockets
  22 |     
  23 |     COPY mt5/bridge.py /root/bridge.py
--------------------
ERROR: failed to build: failed to solve: process "/bin/sh -c wine python -m pip install --no-cache-dir MetaTrader5 websockets" did not complete successfully: exit code: 1
```

Exit code 1. See "Bad news first" above for why: no `python` is registered in the Wine prefix at `docker build` time, because the base image installs its Windows-side Python from its own container-runtime boot script, not from its image layers.
