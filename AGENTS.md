# AGENTS.md

Agent-facing guide for xChief Gold Rush. Harness-agnostic: Claude Code, Codex, and OpenCode all read this file. `CLAUDE.md` is a symlink to it.

## What this is

A marketing-campaign game: predict whether the XAU/USD gold price goes up or down over the next 5 seconds. Correct predictions score points. One core game engine, two modes:

- **Web** - email + OTP auth, score feeds a persistent top-10 leaderboard over a ~1-month campaign. Top 3 win prizes.
- **Kiosk** - no email, runs at the Forex Expo Dubai 2026 booth. Three wins in a row trigger a one-time `$100` bonus code. Code is claimed once, then gone. Next player starts fresh.

Traffic to design for: ~50 concurrent, ~1000 users/day, one month. Everything must auto-scale on managed services and stay fast, especially the kiosk.

Full decisions: `gold-prediction-game-architecture.md`. Read it before backend work.

## The security rule that overrides everything

**The client never reports its own result.** The server issues a round, independently reads the price from the Fly relay at start and at resolve, and decides win or loss itself. There is no code path where a client asserts "I won."

Same for coupons: a kiosk reports "I hit a 3-win streak," the server verifies that against state it tracked itself before releasing a code. Coupon claim is atomic (pick-available-and-mark-claimed in one step) so two simultaneous claims cannot take the same code. Each kiosk holds a bearer secret; the server stores only its hash and checks it on every kiosk action.

If a change would let the client influence its own outcome or coupon eligibility, it is wrong regardless of how clean it looks.

## Stack

- **Vercel** - frontend host (Vite + React). Owned by the marketing lead.
- **Fly.io relay** (`relay/`) - live gold price feed. One job; do not repurpose it.
- **Supabase** - the backend: Postgres, OTP auth (SMTP via Elastic Mail), auto-generated REST/GraphQL API, edge functions. Security is declarative via row-level security (RLS) policies on tables. Client talks to Supabase directly except for the two decisions that must be server-side: round resolution and coupon claim.

## Commands

```
npm run dev        # vite dev server
npm run build      # vite build
npm test           # node --test test/economy.test.mjs
npm run lint       # eslint .
npm run format     # prettier --write .
npm run relay      # run the price relay locally
```

Lint and tests must pass before any change is considered done.

## Working agreements

- **The marketing lead shares `main` and is actively changing the client, assets, and gameplay.** Never push to `main` without being asked. Do backend/infra work on branches or Orca worktrees and keep merges clean.
- Do not edit `CHANGELOG.md` or any file marked auto-generated.
- No em dashes in prose or comments; use a plain `-`.
- Match the surrounding code's style, naming, and comment density.
- Reproduce bugs end-to-end (as a user would hit them) before fixing.
- Fix lint errors, test failures, and flakiness you encounter, even if unrelated to your task.

## Orchestration model

Backend/infra/testing is built by an agent team:

- **Orchestrator** - Claude Opus 4.8. Grills the architecture, writes specs and tickets, dispatches work, reviews and merges. Does not hand-write feature code by default.
- **Workers** - OpenCode Go models running inside Orca-managed worktrees/terminals. Default roster:
  - Builder (features, functions): `opencode-go/kimi-k2.7-code`
  - Heavy builder (schema, tricky logic): `opencode-go/qwen3.8-max`
  - Fast worker (tests, lint, boilerplate): `opencode-go/qwen3.8-flash`
  - Independent reviewer (cross-family): `opencode-go/deepseek-v4-pro`
  - Adversarial / security review: `opencode-go/gpt-5.6-luna`

### Driving an OpenCode Go worker (this machine)

This checkout may run in a sandboxed home where opencode reads an empty credential store. Point it at the real home so OpenCode Go auth resolves:

```
HOME="/c/Users/Kayhan Azadi" USERPROFILE="C:\Users\Kayhan Azadi" \
  opencode run --model opencode-go/<model> "<task>"
```

Workers spawned inside Orca terminals already inherit the correct auth; the override is only for direct calls. Orca handles worktrees and terminals; see the `orca-cli` and `orchestration` skills.
