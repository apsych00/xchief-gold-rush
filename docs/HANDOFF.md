# Handoff: resume on `dev` from a cold session (written 2026-09-18, early)

Read this, then `docs/TRACKER.md` (the one tracker), then `AGENTS.md`. Everything below was true at the moment of writing; verify with the commands given before acting on it.

## Where the code is

- `dev` = `da8e6ab` locally, on `origin` (AIT-ERP) and on `apsych`. Working tree clean. `main` on both remotes is older; nothing goes to any `main` unless the owner says so (the permission classifier blocks it anyway; the owner runs that push).
- Landed on `dev` on 2026-09-17 evening, each with the full gate set green on the merged tree (lint, unit, pgTAP, `test:server`, full E2E): **U1** client polish (no wipe button, user-icon avatar, themed scrollbars, one socket), **U2** fused leaderboard header (cup icon, guest note as the own row, the pinned own row no longer renders over the topbar), **U3** the two animated xChief banners in the ad zone (frame rendered at its native 1072x310 canvas and scaled to the zone width, the bundled assets clip below ~800 px otherwise), **K5** the new server-side email mask (`ped*****ncy@gmail.com`, company domains `f***d@a**.co`) with a leak test.
- Last dev gate run: 145 unit, 295 pgTAP, 98 server, 37 E2E, all green.

## Owner decisions taken during the last session (all reflected in tickets)

- **English only, everywhere.** Ticket **U5** (`docs/tickets/u5-english-only.md`): delete `dict.fa`, every language toggle, rtl CSS, stacked fa/en blocks; keep the i18n plumbing with one language so a proper switcher can return in a later version. K2, K3, K4 tickets say "add English strings only, never fa keys".
- **Kiosk intro, ticket K2.** Three cards, English only, and the first showing ends on a QR code for the web version. The owner looked at the kiosk and confirmed it is already Play only.
- **Screen sprite, ticket D5.** Every web and kiosk screen as separate PNGs plus one contact sheet at 2x under `design/screens/`, which is git-ignored (the entry is committed). The owner wants the absolute path of the sheet as soon as it exists, to hand to a design agent.
- **Worker hygiene.** The owner noticed detached node servers left behind by dead runs, and that worker branches were twelve commits behind `dev` by the time they reported. So, after a worker reports, close its terminal, kill listeners on the ports its ticket assigned (they are the worker's own), `docker rm -f goldrush-<ticket>-keep`, commit the branch, `git merge dev` into it, run the gates on that tree, and only then merge into `dev`.

## In flight when the machine went down (nothing is running now)

All four OpenCode workers stalled after a network drop around 21:35 on 2026-09-17 (`opencode.log` shows `stream error`, the game-server logs show DNS failures). I relaunched them with `opencode run -c` (continue the last session in the worktree) at about 23:00, and then the session ended: Orca reports every terminal handle stale, no `opencode` process is alive, Docker Desktop is not running. Their worktrees under `C:\Users\Kayhan Azadi\orca\workspaces\xchief-gold-rush\` still hold uncommitted work:

| Ticket | Worktree | Model | Ports (DB container / server / Vite) | State on disk |
|---|---|---|---|---|
| U4 share modal + `/s/<token>` page | `u4-share` | deepseek-v4.1-flash | 55466 `goldrush-u4-keep` / 8807 / 5369 | 23 files changed, no report |
| K1 open kiosk route `/kiosk` | `k1-open-kiosk-route` | kimi-k2.7-code | 55467 `goldrush-k1-keep` / 8808 / 5370 | 16 files changed, no report; its `test:server` had finished green |
| K4 Missions tab + YouTube player | `k4-missions-youtube` | kimi-k2.7-code | 55470 `goldrush-k4-keep` / 8811 / 5373 | 11 files changed, no report; its `test:server` had finished green |
| D5 screen sprite | `d5-screen-sprite` | deepseek-v4.1-flash | 55478 `goldrush-d5-keep` / 8813 / 5375 (changed from 8807/5369, which I had wrongly given to both U4 and D5) | 2 files changed, no screenshots yet |

To resume a worker: start Docker Desktop, open an Orca terminal in the worktree and run

```
opencode run -c --model opencode-go/<model> "RESUME after a restart. Continue the same task: follow ./TICKET.md in this directory exactly. First read ./docs/reports/ and git status to see what you already did, then finish what is left (all gates in the foreground, real output pasted) and write the report the ticket names. Rules stay: explicit ./ paths only; never read any file whose name starts with .env (use ./ENV_PUBLIC.txt, ./ENV_BOX_EXAMPLE.txt, ./ENV_PRODUCTION.txt); never kill a process you did not start; use only your own ports: <ports from the table>."
```

`TICKET.md` and the three `ENV_*.txt` copies are already in each worktree (git-ignored). If `-c` finds no session, drop `-c`; the prompt tells the worker to read its own working tree first. If OpenCode is inside its 5-hour window (terminal shows `Error from provider` or `stream error` with the network up), run the same ticket as a live Sonnet session on cb or cbx instead (`D:\tmp\tickets\run-<name>-cb-i.ps1` pattern; see memory `claude-accounts-and-cb-workers`).

Queue after these, in this order because they share files: **U5** English only (ports 55481 / 8814 / 5376, dispatch after U4 and K1 land since both add strings), **K3** Instagram via BoxAPI (after K4, shares `Tasks.jsx`), **K2** kiosk intro + QR (after U1 and K1; U1 is in). Tickets are in `docs/tickets/`.

## Bringing the owner's dev client back (they walk http://localhost:5173 and tweak UI on `dev`)

Order: Docker Desktop, then from the repo root:

1. `docker compose --profile mt5 up -d db mt5` (the untracked, git-ignored `docker-compose.override.yml` publishes caddy 8080:80, db 127.0.0.1:55480, mt5 127.0.0.1:8765; caddy, server and dozzle stay down for the walk). Never `docker compose down -v`: it wipes the MT5 profile (tracker G12) and the first login has to be redone through the VNC page with Playwright (`docs/mt5-feed.md`, "First login").
2. Relay: `PORT=8788 FINNHUB_TOKEN=<from .env.box> node relay/server.js`.
3. Game server on 8787 from the main checkout: `DATABASE_URL=postgresql://postgres:<POSTGRES_PASSWORD from .env.box>@127.0.0.1:55480/postgres PLAYER_TOKEN_SECRET=dev-secret TRUST_PROXY=0 PUBLIC_URL=http://localhost:5173 FEED_RELAY_WS=ws://localhost:8788/ws MT5_BRIDGE_WS=ws://localhost:8765 MAX_ANON_PLAYERS_PER_IP_PER_10MIN=200 MAX_CONNECTIONS_PER_IP_PER_MIN=300 node server/index.js`. Pass secrets from the environment without printing them.
4. `npx vite --port 5173 --strictPort` with `VITE_GAME_WS=ws://localhost:8787/ws`. Kiosk view: `/kiosk` (set `KIOSK_OPEN_PROVISION=1` on the server first).
5. Check `/status` on 8787: `feed.source` should read `mt5` once the bridge is up (the compose volume `mt5_data` keeps the logged-in profile), `finnhub` (through the relay) otherwise.

The compose database on 55480 already carries K5's `mask_email` (applied by hand with `create or replace function`). Any future `db/schema.sql` change made by a worker has to be applied to that database the same way, or the walk shows stale behaviour. Before a box deploy the full schema still needs D4 (tracker).

**Owner's edits.** Before every merge into `dev`, run `git checkout -- docs/reports` (E2E runs rewrite tracked screenshots, tracker X8), then `git add -A && git commit -m "Owner UI tweaks"` if anything real remains. Never overwrite those lines. I once swept a pile of regenerated PNGs into an "Owner UI tweaks" commit by skipping that first step; harmless, but it muddies the history.

## The verification loop (unchanged)

In the worker's worktree after `git merge dev`: `db/run-tests.sh` copied with a free port and a `goldrush-verifyN-keep` name (I used 55472-55477; 55479, 5178, 5199 are Windows-reserved), `npm run lint`, `npm run test:unit`, `npm run build`, the copied DB script with `--keep`, `DATABASE_URL=... PORT=877x npm run test:server`, then `BASE_URL=http://localhost:536x PORT=877x PUBLIC_URL=http://localhost:536x VITE_GAME_WS=ws://localhost:877x/ws FAKE_INSTAGRAM_PORT=98xx TRUST_PROXY=0 npx playwright test`. Then `rm -f TICKET.md ENV_*.txt db/run-tests-verify.sh`, commit on the branch, merge into `dev`, resolve (screenshot conflicts: take the branch's copies), rerun the gates on the merged tree only if the merge touched code, commit, `git push origin dev`, `git push apsych dev:dev` (run the two pushes as separate commands; a combined command tripped the classifier once), `orca worktree rm --worktree branch:nightmareinc/<name> --force`, tracker row plus a "Landed on dev today" line.

Monitor pattern for worker terminals (handles in `D:\tmp\tickets\orca-stage23.txt`, one per line): poll `orca terminal read --terminal <h> --screen` every 2 minutes for `^PS C:` (back at the prompt), `auto-rejecting` (it tried to read `.env*`), `Error from provider`, `stream error`, `limit reached`.

## Stale Orca worktrees (not mine to delete without the owner)

`b14-streak-tests`, `b15-mt5-docker`, `b16-e2e-regression`, `b1-tournaments`, `box-client`, `box-demo`, `box-server`, `c2b-idle`, `c3-c4-web-identity`, `c6-c7-web`, `c8-no-codes`, `d1-monitoring`, `d2-deploy`, `s17-mt5` are leftovers from merged tickets; the owner already asked about them once. Confirm with `git log dev --oneline | grep -i <ticket>` and remove with `orca worktree rm ... --force` when the owner says so.

## Waiting on the owner

- The `main` push and the `demo-1` tag (Demo 33/33 merged; the showcase against the compose build was stopped by the owner before the tag).
- Venue numbers for the per-IP limits (kiosk ~10 devices, web ~1000 users; the owner wants to talk it through, not the literal numbers).
- Credential rotation after the B1 worker read `.env` (Supabase access token, Fly token, Vercel token).
- `BOXAPI_TOKEN` in `.env.box` (placeholder present), `PASSWORD` for the MT5 VNC page, Telegram bot token and chat id.
- The stale worktree cleanup above.

## Known problems to keep in mind

- **X8, screenshot churn.** Every full E2E run rewrites tracked PNGs under `docs/reports/`, so every merge conflicts on them. The carded fix moves spec output to an ignored folder and keeps curated copies in the reports. Worth doing before the next batch; it cost me four conflict resolutions in one evening.
- **X7, leaderboard `key` warning** before the first server frame. Pre-existing and harmless.
- Workers must never be given overlapping ports; I did that once (U4 and D5). The table above is the current allocation; U5 got 55481 / 8814 / 5376.
- OpenCode dies on any `.env*` read and on paths outside its worktree; the prompt above covers both.
- `git commit -a` during a resolved-but-uncommitted merge completes the merge; keep tracker edits separate from merge resolution.
