TICKET B15 harden, second pass: the container must survive its own first boot. Worktree `b15-review`, on top of the previous worker's uncommitted hardening (read docs/reports/b15-harden.md, then `git status` and `git diff f154cb4`).

Read AGENTS.md, .claude/agents/builder.md, mt5/entrypoint.sh, mt5/Dockerfile, mt5/bridge.py, docker-compose.yml (mt5 service), docs/mt5-feed.md. Never open a file named .env. Never commit. Work only in this worktree.

What the orchestrator saw on a clean run (project `b15verify`, fresh volume, image cached), verbatim from the logs:

```
07:24  [3/7] Installing MetaTrader 5...
07:28:11 [entrypoint] starting bridge.py...
Fatal Python error: init_fs_encoding: failed to get the Python codec of the filesystem encoding
ModuleNotFoundError: No module named 'encodings'
X connection to :1 broken (explicit kill or server shutdown).
... container restarting, RestartCount 10, every restart:
[entrypoint] found terminal at: .../terminal64.exe
[entrypoint] found Wine Python at: .../Python39-32/python.exe
[entrypoint] bootstrapping pip via ensurepip ... Fatal Python error (same)
[entrypoint] pip install failed - will retry on next container start
[entrypoint] starting bridge.py... Fatal Python error (same)
```

Diagnosis to confirm, not assume: the entrypoint's readiness test (terminal64.exe present and a python.exe found) fired while the base image's start.sh was still unpacking Python; ensurepip and bridge.py ran against a half-installed interpreter, bridge.py exited, and because the CMD is s6's foreground child the whole container halted mid-install. The persisted `/config` volume then holds a permanently broken Python, so every restart fails the same way in seconds. The previous report's green run was on a volume that had already completed the install before the entrypoint was ever changed.

Decisions (do not redesign):
1. Readiness = the base image's own completion signal, not file presence. Find what start.sh writes or logs at its last step (`[7/7]` or a marker under /config) and wait for that; if there is no marker, wait until `python.exe -c "import encodings, sys; print(sys.version)"` succeeds under Wine, with the check itself unable to halt the container.
2. The entrypoint never exits. bridge.py runs in a supervised loop with exponential backoff (5 s to 5 min); every crash is logged with the last 20 lines of its output; the health endpoint reports `bridge: down` while it is not running. The container may only stop by `docker stop`.
3. Recovery from a poisoned volume is documented and scripted: `mt5/reset-volume.sh` (compose down, `docker volume rm <project>_mt5_data`, up) in docs/mt5-feed.md "If the bridge never starts".
4. Proof: a real clean run (`docker compose -p b15v2 --profile mt5 up -d --build` with a fresh volume, throwaway env from .env.box.example, never FINNHUB_TOKEN), followed for the whole cold boot until the bridge answers on 8765 and /healthz on 8766; then `docker restart` and show the warm start; then `docker compose -p b15v2 --profile mt5 down -v`. Paste the timestamps and the last 15 log lines of each phase into docs/reports/b15-harden.md as a new "Second pass" section, replacing the earlier "Proving it" claims that no longer hold.
Gates unpiped: lint, unit, `python -m pytest test/mt5 -q`. Report: bad news first, what the real readiness signal turned out to be, files touched, gate outputs.
