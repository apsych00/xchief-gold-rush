# MT5-under-Wine terminal + tick bridge (docs/mt5-feed.md "Bridge route"),
# an alternative to the MetaApi source in server/feed-mt5.js. Off by default:
# only built/started with `docker compose --profile mt5 up` (docker-compose.yml).
#
# Base: gmag11/metatrader5_vnc, a maintained image that already carries Wine,
# a Windows-side Python under Wine, Xvfb + a VNC server, and boot scripts
# that install and launch the MT5 terminal - building that from scratch here
# would just re-derive the same image with more moving parts to keep patched.
# NOT verified against a pulled copy of the tag in this worktree (no network
# egress here to pull it, and no way to log in and inspect it) - the exact
# path to the base image's own Windows Python and its supervisor script name
# is the first thing to confirm against the real image before this is used
# on the box; `docker build mt5/` below is the check for that.
FROM gmag11/metatrader5_vnc:latest

WORKDIR /root

# The MetaTrader5 pip package is Windows-only (ctypes into a DLL the running
# terminal loads), so it has to go into the base image's Wine-side Python,
# not any Linux-side one. `websockets` rides along for bridge.py's server.
RUN wine python -m pip install --no-cache-dir MetaTrader5 websockets

COPY mt5/bridge.py /root/bridge.py

ENV MT5_BRIDGE_PORT=8765
EXPOSE 8765

# The base image's own entrypoint boots Xvfb, Wine and the terminal, then
# execs its CMD; this replaces only the CMD so the bridge starts once that
# boot sequence hands off. If the base image gates readiness behind its own
# wait script, this CMD is the second thing to adjust after confirming the
# base image's actual boot contract.
CMD ["wine", "python", "/root/bridge.py"]
