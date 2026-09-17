# MT5-under-Wine terminal + tick bridge (docs/mt5-feed.md "Bridge route"),
# an alternative to the MetaApi source in server/feed-mt5.js. Off by default:
# only built/started with `docker compose --profile mt5 up` (docker-compose.yml).
#
# Base: gmag11/metatrader5_vnc (a linuxserver.io s6-overlay v3 image, pinned
# below by digest). Verified against a pulled copy of this exact digest
# (docs/reports/b15-harden.md has the evidence): it carries Wine, KasmVNC,
# and an openbox autostart (/defaults/autostart -> /Metatrader/start.sh) that
# installs Mono, the MT5 terminal and a Windows-side Python into the Wine
# prefix (/config/.wine) the first time the container's desktop session
# comes up - at container *runtime*, not baked into these image layers.
# Nothing MT5-related can be pip-installed here at build time as a result;
# mt5/entrypoint.sh (this image's CMD) waits for that runtime install to
# finish, then installs MetaTrader5 + websockets into the now-present Wine
# Python exactly once (marker file under /config, the persisted volume) and
# hands off to bridge.py.
FROM gmag11/metatrader5_vnc@sha256:2fdff449cf70b74c242319828b6859592ab52dfb05690d9a989c75107dabf4c1

WORKDIR /root

# bridge.py runs as the base image's own `abc` user (uid 911), not root - see
# entrypoint.sh - so it cannot live under /root (mode 0700, root-only,
# confirmed against the pulled image: abc got "Permission denied" reading it
# from there). entrypoint.sh itself still runs as root and stays put.
COPY mt5/bridge.py /opt/mt5-bridge/bridge.py
COPY mt5/entrypoint.sh /root/entrypoint.sh
RUN chmod +x /root/entrypoint.sh && chmod -R a+rX /opt/mt5-bridge

ENV MT5_BRIDGE_PORT=8765
ENV MT5_BRIDGE_HEALTH_PORT=8766
EXPOSE 8765
EXPOSE 8766

# The base image's own ENTRYPOINT (/init, s6-overlay) is untouched: it still
# brings up Xvfb/KasmVNC/openbox and, through openbox's autostart, the MT5
# terminal install/login. This CMD runs as s6-overlay stage2's own foreground
# child once the "top" bundle's services report up - confirmed against the
# pulled image's /package/admin/s6-overlay-*/etc/s6-linux-init/skel/rc.init -
# which also means if this process exits, s6 halts the whole container and
# `restart: unless-stopped` brings it back from a cold boot. entrypoint.sh
# never exits on a transient error for exactly that reason.
CMD ["/root/entrypoint.sh"]
