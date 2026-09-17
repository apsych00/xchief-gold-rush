#!/usr/bin/with-contenv bash
# Runtime install + start wrapper for the mt5 service CMD (mt5/Dockerfile).
#
# `with-contenv` is not decoration: s6-overlay strips the process environment
# down to nothing before running stage2's foreground command (verified
# against the pulled image - a plain #!/bin/bash here left WINEPREFIX and
# XDG_RUNTIME_DIR both unset, so `wine` silently created a throwaway prefix
# at /root/.wine instead of reusing /config/.wine, the persisted volume,
# right next to the base image's own installed terminal and Python). Every
# other script in this base image (svc-de/run, init-nginx/run, ...) uses the
# same shebang for the same reason - it re-imports /run/s6/container_environment,
# which is where WINEPREFIX, XDG_RUNTIME_DIR, DISPLAY etc. actually live.
#
# gmag11/metatrader5_vnc is a linuxserver.io s6-overlay v3 image. Its own
# openbox autostart (/defaults/autostart -> /Metatrader/start.sh) downloads
# Mono, the MT5 terminal and a Windows-side Python into the Wine prefix the
# first time the container's desktop session comes up - at container
# *runtime*, not in the image's build layers. Docker's CMD (this script) is
# started by s6-overlay's stage2 in parallel with that autostart sequence,
# not after it (confirmed against the pulled image: s6-rc brings the "top"
# bundle's services to "up", which for a longrun like the desktop session
# means "started", not "finished its autostart app"). So nothing here can
# assume the terminal or a Wine-side Python already exist; both have to be
# waited for before handing off to bridge.py.
#
# The wait target matters and got this wrong twice already:
#
# First bug (see docs/reports/b15-harden.md "Second pass" for the drill-down):
# start.sh (pulled and read in full) installs Python with
# `/quiet InstallAllUsers=1 PrependPath=1`, which can leave python.exe
# present as a file while the installer is still unpacking the stdlib next
# to it - a readiness check keyed on file presence alone can fire mid-unpack
# and hand a half-installed interpreter to `ensurepip`/pip, corrupting it
# (`ModuleNotFoundError: No module named 'encodings'` on every restart after
# that, because the poisoned state lands on the persisted /config volume).
#
# Second bug, found by running this fix against the real base image (not
# reasoning about it): the first version of this wait also required
# start.sh's own step 7 - the `mt5linux` server it starts on 0.0.0.0:8001 -
# to be listening, on the theory that step 7 only ever runs after every
# earlier step (including step 6's pip installs) has returned. That part is
# true, but step 7 itself is broken on this base image's pinned digest:
# `python3 -m mt5linux` on the *Linux* side hits a SyntaxError in the
# `mt5linux` package's own bundled `metatrader5.py` (an f-string with nested
# braces that Python 3.11 - this image's Linux-side interpreter - rejects).
# start.sh logs "[7/7] Failed to start the mt5linux server" and moves on
# without exiting, so the container never crashes - but the port never
# opens, either, so a readiness check gated on it waits forever (confirmed
# directly: a container built from this fix sat on "still waiting" for over
# an hour with the terminal, Wine Python and Wine-side MetaTrader5 package
# already fully installed). We don't use that server anyway (bridge.py talks
# to the MetaTrader5 package in-process under Wine, not over rpyc/mt5linux),
# so it is not a signal worth depending on regardless of whether it works.
#
# The actual thing we need from start.sh is step 6: the Wine-side pip
# installs (`MetaTrader5==5.0.36`, `mt5linux`, `python-dateutil`) into the
# same interpreter bridge.py will run under. Confirmed directly against a
# stuck container: once the interpreter itself imports cleanly (proof it is
# not mid-unpack, the first bug above) and MetaTrader5's dist-info is on
# disk under Wine's site-packages, step 6 has already returned - regardless
# of whether step 7 ever succeeds. `import MetaTrader5` itself is not usable
# as the check: it is expected to fail here with
# `AttributeError: _ARRAY_API not found` (unconstrained numpy 2.x, the same
# bug this script's own `numpy<2` pin exists to fix below) until *after*
# this script's own install step runs, so gating on it would be circular.
#
# `set -e` is deliberately NOT used: this process is stage2's foreground
# child (verified against /package/admin/s6-overlay-*/etc/s6-linux-init/skel/rc.init
# in the pulled image) - if it exits, s6 halts the whole container. A
# transient failure here should keep retrying, not take the container down;
# bridge.py itself is run under its own supervised retry loop below for the
# same reason.

WINEPREFIX="${WINEPREFIX:-/config/.wine}"
MT5_TERMINAL="$WINEPREFIX/drive_c/Program Files/MetaTrader 5/terminal64.exe"
MARKER="/config/.mt5-bridge-deps-installed"
BRIDGE_LOG="$(mktemp -t mt5-bridge-log.XXXXXX)"
HEALTH_PORT="${MT5_BRIDGE_HEALTH_PORT:-8766}"
POLL_S=5
LOG_EVERY_S=60

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [entrypoint] $*"; }

# /config/.wine is owned by abc (uid 911, the same user openbox's autostart
# and start.sh run as), but this CMD process runs as root - `wine` refuses
# to touch a prefix it does not own ("'/config/.wine' is not owned by you").
# s6-setuidgid abc matches every other script in this base image.
run_as_abc() { s6-setuidgid abc "$@"; }

find_wine_python() {
  # The venv stdlib module ships its own python.exe *stub* under
  # Lib/venv/scripts/nt/ - it exists as soon as Python is unpacked but has no
  # pip and isn't a real interpreter to run bridge.py under. Exclude any
  # python.exe nested under a Lib/ directory so only the top-level
  # installed interpreter (drive_c/.../PythonXY[-32]/python.exe) matches.
  find "$WINEPREFIX/drive_c" -iname 'python.exe' -not -ipath '*uninstall*' -not -ipath '*/lib/*' 2>/dev/null | head -n1
}

wine_python_imports_cleanly() {
  # Half-unpacked stdlib (the first bug above) fails here with
  # "No module named 'encodings'"; this is the only reliable proof the
  # interpreter itself is not mid-install.
  run_as_abc wine "$1" -c "import encodings, sys" >/dev/null 2>&1
}

wine_metatrader5_dist_info_present() {
  # Proof that start.sh's step 6 (`wine python -m pip install MetaTrader5==...`)
  # has already run, without importing the package - MetaTrader5 imports fine
  # under Wine only after this script's own numpy<2 pin below runs.
  find "$WINEPREFIX/drive_c" -iname 'MetaTrader5-*.dist-info' -type d 2>/dev/null | grep -q .
}

log "waiting for the base image's own boot (Mono + MT5 terminal + Wine Python + start.sh's own MetaTrader5 pip install, via /Metatrader/start.sh) to finish..."
waited=0
wine_python=""
while true; do
  wine_python="$(find_wine_python || true)"
  if [ -f "$MT5_TERMINAL" ] && [ -n "$wine_python" ] \
    && wine_python_imports_cleanly "$wine_python" \
    && wine_metatrader5_dist_info_present; then
    break
  fi
  if [ $((waited % LOG_EVERY_S)) -eq 0 ] && [ "$waited" -gt 0 ]; then
    log "still waiting (${waited}s so far) - terminal present: $([ -f "$MT5_TERMINAL" ] && echo yes || echo no), wine python present: $([ -n "$wine_python" ] && echo yes || echo no), wine python imports cleanly: $([ -n "$wine_python" ] && wine_python_imports_cleanly "$wine_python" && echo yes || echo no), MetaTrader5 pip-installed by start.sh: $(wine_metatrader5_dist_info_present && echo yes || echo no)"
  fi
  sleep "$POLL_S"
  waited=$((waited + POLL_S))
done
log "found terminal at: $MT5_TERMINAL"
log "found Wine Python at: $wine_python"
log "Wine interpreter imports cleanly and start.sh's own MetaTrader5 install is done"

if [ ! -f "$MARKER" ]; then
  # start.sh's own step 6 already installs pip, MetaTrader5==5.0.36,
  # mt5linux and python-dateutil into this same interpreter (confirmed by
  # reading start.sh out of the pulled image - see the block comment above).
  # Re-running ensurepip/a plain `pip install MetaTrader5` here would either
  # be redundant or, worse, race start.sh's own pip invocation if this fired
  # before step 6 returned - which can no longer happen now that we wait for
  # its dist-info to land. What start.sh does NOT do: pin numpy (MetaTrader5's
  # compiled _core extension needs numpy<2, but MetaTrader5's own metadata only declares
  # "numpy>=1.7", so an unconstrained resolve can leave numpy 2.x installed
  # and MetaTrader5 failing at import with "AttributeError: _ARRAY_API not
  # found" - confirmed against the pulled image), or install `websockets`
  # (bridge.py's only dependency start.sh has no reason to know about).
  log "reconciling numpy<2 and installing websockets (start.sh already installed MetaTrader5 + pip)..."
  if run_as_abc wine "$wine_python" -m pip install --no-cache-dir "numpy<2" websockets; then
    touch "$MARKER"
    chown abc:abc "$MARKER"
    log "install done."
  else
    log "pip install failed - will retry on next container start (no marker written)."
  fi
else
  log "numpy<2 + websockets already installed ($MARKER exists) - skipping."
fi

# --- supervised bridge.py loop -----------------------------------------
#
# bridge.py already guards its own poll loop against terminal/tick errors
# (docs/reports/b15-harden.md items 7-8), but an exception escaping run()
# itself - a bad import, a fatal asyncio error - would previously exit this
# script, which s6 treats as this CMD ending: the whole container halts and
# gets recreated from a cold boot by `restart: unless-stopped` (confirmed
# against rc.init - see the block comment above). That turns one bridge.py
# bug into a ~13-minute outage even on a warm /config volume replaying only
# the parts start.sh re-checks. bridge.py now runs in a loop this script
# owns: a crash is logged (with its last 20 lines of output) and retried
# with exponential backoff (5s, 10s, ..., capped at 5 minutes) instead of
# ending the script. Only `docker stop` (SIGTERM to this script) ends it.
#
# While bridge.py is down (crashed, mid-backoff), nothing is listening on
# $HEALTH_PORT - bridge.py owns that port only while it runs. A placeholder
# health responder takes over the port for exactly that window so
# /healthz keeps answering "bridge: down" instead of connection-refused,
# which is indistinguishable from "still cold-booting" to anything polling
# it (docker's own healthcheck, or an operator's curl).
start_down_health() {
  python3 -u - "$HEALTH_PORT" <<'PY' &
import http.server
import socketserver
import sys

port = int(sys.argv[1])


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"bridge: down"
        self.send_response(503)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class Server(socketserver.TCPServer):
    allow_reuse_address = True


with Server(("0.0.0.0", port), Handler) as httpd:
    httpd.serve_forever()
PY
  DOWN_HEALTH_PID=$!
}

stop_down_health() {
  if [ -n "${DOWN_HEALTH_PID:-}" ]; then
    kill "$DOWN_HEALTH_PID" 2>/dev/null || true
    wait "$DOWN_HEALTH_PID" 2>/dev/null || true
    DOWN_HEALTH_PID=""
  fi
}

log "starting bridge.py under supervision (this script never exits; only 'docker stop' does)..."
attempt=0
while true; do
  start_ts=$(date +%s)
  run_as_abc wine "$wine_python" /opt/mt5-bridge/bridge.py >"$BRIDGE_LOG" 2>&1
  exit_code=$?
  ran_for=$(($(date +%s) - start_ts))

  log "bridge.py exited (code $exit_code) after ${ran_for}s - last 20 lines of its output:"
  tail -n 20 "$BRIDGE_LOG" 2>/dev/null | while IFS= read -r line; do log "  $line"; done

  # A bridge that ran cleanly for a while before dying gets a fresh backoff
  # clock rather than inheriting a long delay from a much earlier crash.
  if [ "$ran_for" -ge 60 ]; then
    attempt=0
  fi

  start_down_health
  delay=$((attempt > 6 ? 300 : 5 * (2 ** attempt)))
  attempt=$((attempt + 1))
  log "restarting bridge.py in ${delay}s (attempt $attempt); /healthz reports 'bridge: down' until then"
  sleep "$delay"
  stop_down_health
done
