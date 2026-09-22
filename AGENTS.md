# AGENTS.md

Agent-facing guide for xChief Gold Rush. Harness-agnostic: Claude Code, Codex, and OpenCode all read this file. `CLAUDE.md` is a symlink to it.

## What this is

A marketing-campaign game: predict whether the XAU/USD gold price goes up or down over the next 5 seconds. Correct predictions score points. One core game engine, two modes:

- **Web** - email + OTP auth, score feeds a persistent top-10 leaderboard over a ~1-month campaign. Top 3 win prizes.
- **Kiosk** - no email, runs at the Forex Expo Dubai 2026 booth. Three wins in a row trigger a one-time `$100` bonus code. Code is claimed once, then gone. Next player starts fresh.

Traffic to design for: ~50 concurrent, ~1000 users/day, one month. It all runs on one box, so nothing scales itself: keep the server process cheap and the kiosk fast.

The kiosk is the demanding one. It runs unattended for 48 hours on an iPad while a queue of strangers share the same browser session, and it has to return itself to a clean attract screen every time with nobody touching it.

Start with `docs/ARCHITECTURE.md` for the map, `docs/box-architecture.md` for the deployment detail, and `docs/layers.md` for what was built in what order.

## The security rule that overrides everything

**The client never reports its own result.** The server issues a round, independently reads the price from its own feed at start and at resolve, and decides win or loss itself. There is no code path where a client asserts "I won."

Same for coupons: a kiosk reports "I hit a 3-win streak," the server verifies that against state it tracked itself before releasing a code. Coupon claim is atomic (pick-available-and-mark-claimed in one step) so two simultaneous claims cannot take the same code. Each kiosk holds a bearer secret; the server stores only its hash and checks it on every kiosk action.

If a change would let the client influence its own outcome or coupon eligibility, it is wrong regardless of how clean it looks.

## Stack

Everything runs on one machine, "the box", as docker containers:

- **Caddy** - serves the built client and proxies `/ws` and `/api`. Cloudflare sits in front for DNS, TLS and edge shielding.
- **Game server** (`server/`) - one Node process. Rounds, price aggregation with failover across several upstreams, coins, prizes, identity, rate limits, safe mode. It is the only thing that talks to the database.
- **Postgres 16** - all durable state. Migrations in `db/migrations`, applied on boot by `server/migrate.mjs`.
- **Client** (`src/`) - Vite plus React, built to static files. One codebase, two modes; kiosk mode is the `/kiosk` route, which self-provisions its own device-stored identity. There is no secret in the URL.

Clients hold a single WebSocket carrying gameplay, identity and leaderboard updates.

**Present but not deployed, do not mistake these for live:** `relay/` (the old Fly price relay, now superseded by `server/feed.js`), `api/lead.js` and `vercel.json` (the old Vercel path), and the whole earlier Supabase design. Because the server is now the only database client, there is no row-level security layer to reason about.

## Commands

```
npm run dev              # vite dev server
npm run build            # vite build
npm run lint             # eslint .
npm run format           # prettier --write .

npm test                 # the economy test
npm run test:unit        # unit tests
npm run test:server      # box integration tests (needs the stack up)
npm run test:e2e         # playwright

npm run box:up           # bring the whole stack up with docker compose
npm run box:logs         # follow the server log
npm run box:coupons:load # load the prize pool
```

Run the suite that covers what you touched; do not gate on the full set. Lint and the relevant tests must pass before a change is considered done.

Local gotchas worth knowing before you burn an hour:

- The app runs at **http://localhost:8080** via docker. Ports 8792, 5192 and 8787 are wrong.
- The repo `.env` `DATABASE_URL` points at **cloud Supabase**, not the local box. For local work use `docker exec xchief-gold-rush-db-1 psql -U postgres`.
- Playwright is 1.63: `page.accessibility.snapshot()` is gone. Use `await page.locator('body').ariaSnapshot()`.
- Client changes need the container rebuilt before they show at `:8080`.

## Working agreements

- **`main` is the deploy branch: the box builds from it.** `dev` is the signed-off working branch. Never push either without being asked. Do all work on branches or Orca worktrees and keep merges clean.
- **Never point a test, script or agent at the live site** (`goldrush.xchief.academy`). Local only.
- Do not edit `CHANGELOG.md` or any file marked auto-generated.
- No em dashes in prose or comments; use a plain `-`.
- Match the surrounding code's style, naming, and comment density.
- Reproduce bugs end-to-end (as a user would hit them) before fixing.
- Fix lint errors, test failures, and flakiness you encounter, even if unrelated to your task.

## Orchestration model

Backend/infra/testing is built by an agent team:

- **Orchestrator** - Claude Opus. Grills the architecture, writes specs and tickets, dispatches work, reviews and merges. Does not hand-write feature code by default. Verifies worker claims rather than trusting completion messages: agents on this repo have reported work they never did.
- **Workers** - OpenCode Go models, or Antigravity Gemini via the `agy` CLI, running inside Orca-managed worktrees/terminals. Default OpenCode roster:
  - Builder (features, functions): `opencode-go/kimi-k2.7-code`
  - Heavy builder (schema, tricky logic): `opencode-go/qwen3.8-max`
  - Fast worker (tests, lint, boilerplate): `opencode-go/qwen3.8-flash`
  - Independent reviewer (cross-family): `opencode-go/deepseek-v4-pro`
  - Adversarial / security review: `opencode-go/gpt-5.6-luna`

### Driving an OpenCode Go worker (this machine)

Spawn the agent **first**, let it come up, and only then give it the task. Firing the task and the launch together is what leaves workers sitting dead at a prompt:

```
orca orchestration run-create --objective "<objective>" --json
orca orchestration task-create --spec "<the full ticket>" --json
orca terminal create --worktree "path:<worktree>" --command "opencode" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 150000 --json
orca orchestration dispatch --task <task_id> --to <handle> --inject --json
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms <n> --json
```

Notes that cost time when missed:

- The task id is the `task_...` value from `task-list`, not the `id` in the response envelope.
- Orca terminals are **PowerShell**. Bash syntax sent with `terminal send` dies on a ParserError.
- If `opencode` is not found in a fresh terminal, launch it by full path (`D:\dev-storage\npm\global\opencode.cmd`).
- Long tasks routinely run 15 to 60 minutes. A `check --wait` timeout is a checkpoint, not a failure; keep waiting rather than killing the worker.
- Direct `opencode` calls from a sandboxed home read an empty credential store. Workers inside Orca terminals inherit the right auth; only direct calls need `HOME="/c/Users/Kayhan Azadi" USERPROFILE="C:\Users\Kayhan Azadi"`.

Antigravity Gemini workers use `agy` instead. Its `--print` and `-i` flags swallow the next token, so attach the prompt to the flag (`-i="..."`) and put `--model` elsewhere on the line.

Orca handles worktrees and terminals; see the `orca-cli` and `orchestration` skills, and load the version-matched guide with `orca skills get orchestration`.
