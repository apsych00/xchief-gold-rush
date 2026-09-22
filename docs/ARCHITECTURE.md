# xChief Gold Rush - architecture

Orientation map for the system as it actually runs today. For the deployment topology in
full detail see `box-architecture.md`; for what was built in what order and why, see
`layers.md`. This file is the one to read first.

## What the product is

A marketing-campaign game. You predict whether the XAU/USD gold price goes up or down over
the next 5 seconds. One game engine, two very different products on top of it:

- **Web.** Anonymous play first, then email plus a login code. Scores feed a persistent
  leaderboard across a campaign season. Tasks and rewards top up coins.
- **Kiosk.** No email, no leaderboard, no tasks. Runs on an iPad at the Forex Expo Dubai
  booth. Three wins in a row wins a one-time $100 code, claimed on the winner's own phone.
  Then the machine resets for the next stranger.

The kiosk is the demanding one. It runs unattended for 48 hours while a queue of strangers
use the same browser session, and it must return itself to a clean attract screen every
time without anyone touching it.

## The rule that overrides everything

**The client never reports its own result.** The server opens a round, reads the price
itself at start and at resolve, and decides win or loss. There is no path where a client
asserts "I won".

The same holds for prizes. A kiosk reports that it hit a 3-win streak; the server checks
that against a streak it tracked itself before releasing a code. Claiming a coupon is a
single atomic step, so two simultaneous claims can never take the same code. Each kiosk
carries a bearer secret and the server stores only its hash.

If a change would let a client influence its own outcome or its prize eligibility, it is
wrong no matter how clean it looks.

## Topology

One machine. Everything of consequence is in one Node process talking to one Postgres.

```
visitors and booth kiosks
        |
   Cloudflare (DNS, TLS, edge shielding)
        |
   Caddy container  -- serves the built client, proxies /ws and /api
        |
   game server container (Node, single process)
        |                         \
   Postgres 16 container           outbound: price feeds, email, Instagram
```

Supporting containers: Dozzle for logs, and Cloudflare Tunnel in the box compose file.

| Part | Owns | Never does |
|---|---|---|
| Cloudflare | Public DNS, TLS, absorbing junk traffic | Hold game state |
| Caddy | Static client, reverse proxy for socket and API | Make game decisions |
| Game server | Rounds, prices, coins, prizes, identity, limits | Trust the client |
| Postgres | All durable state | Get talked to by anything but the server |

Clients hold one WebSocket. That socket carries gameplay, identity and leaderboard updates.

## The server, module by module

Everything under `server/`, one process:

| Module | Responsibility |
|---|---|
| `index.js` | HTTP and WebSocket entry, frame routing, health and status |
| `rounds.js` | Round lifecycle. Opens against the live price, arms a 5 second in-memory timer, resolves from whatever the feed publishes at fire |
| `feed.js` | Price aggregation. Several upstream sources held hot at once with failover between them, so a dead source never stalls a round |
| `feed-mt5.js`, `feed-mt5-bridge.js` | MetaTrader feed path |
| `ledger.js` | All Postgres access. Coins, players, devices, scores, tasks, coupons. The only thing that touches the database |
| `kiosk.js` | The idle sweep. Brings an abandoned kiosk back to attract on its own, the safety net behind the client's own countdown |
| `otp.js` | Login codes. Generated and hashed in the database; this module only delivers them by email |
| `limits.js` | Per-socket and per-IP rate limits, in memory, swept so a long campaign cannot grow them without bound |
| `safemode.js` | Server-wide throttle with three levels, to shrink what unknown clients can do during a flood without disturbing connected players |
| `instagram.js` | Instagram follow reward, implemented as a read of a handle rather than a login |
| `alerts.js` | Best-effort pings when the feed goes quiet, the server restarts, safe mode changes, or the coupon pool runs low |
| `migrate.mjs` | Applies `db/migrations` on boot |

## The client

Vite plus React, built to static files that Caddy serves. One codebase, two modes chosen at
load time by the route: `/kiosk` is the booth surface, everything else is the web surface. A
kiosk's bearer secret lives only in that device's local storage, never in the URL.

- `useGame.js` - the shared engine: socket, rounds, coins, profile, identity, routing
- `useKioskFlow.js` - kiosk screen machine: `attract`, `playing`, `won`, `broke`,
  `no_codes`, plus the idle countdown and the reset on return to attract
- `KioskApp.jsx` - the booth surface. Deliberately shows no email, tasks or leaderboard
- `App.jsx` - the web surface: leaderboard, profile, tasks, sharing, identity
- `ClaimPage.jsx` - the phone page a booth winner lands on after scanning the QR code
- `priceFeed.js` - the chart's own view of the price, display only, never authoritative

## Data

Postgres, migrations in `db/migrations`. The domains:

- **Identity** - `players`, `devices`, `otp_codes`, `dev_otps`
- **Gameplay** - `rounds`, `settings`
- **Kiosk and prizes** - `kiosks`, `coupons`, `claim_links`
- **Campaign** - `tournaments`, `tournament_scores`, `tournament_results`, `badge_tiers`
- **Engagement** - `tasks`, `task_claims`, `task_visits`, `video_progress`,
  `instagram_accounts`

Kiosk secrets are stored only as bcrypt hashes and cannot be recovered; a device that loses
its local storage, or whose kiosk row is revoked, self-provisions a fresh one the next time it
opens `/kiosk`.

## The two journeys

**Booth visitor.** Walks up to the attract screen, taps in, plays 5 second rounds against a
server-owned pot of coins. It ends one of three ways: three wins in a row and a prize modal
with a QR code they photograph and claim on their phone; coins gone and a clear exit; or
they walk away and the kiosk counts down and flushes itself back to attract. The prize pool
can run dry, which is its own screen rather than a broken one.

**Web player.** Plays anonymously, then at a milestone gives an email and a login code.
From then on the interface shows who they are playing as, masked. The leaderboard is live
over the socket and shows masked emails only. Running out of coins is not an exit, it is
the route into tasks and rewards.

## Vestigial, present but not deployed

Do not mistake these for the live system:

- `relay/` - the old Fly.io price relay. The box server does its own aggregation now in
  `server/feed.js`, which took this as its starting point.
- `api/lead.js` and `vercel.json` - the old Vercel serverless hosting path.
- Supabase. An earlier design put Postgres, auth and row-level security there. The box
  replaced it. Nothing in that design is deployed, and the server is now the only thing
  that speaks to the database, so there is no row-level security layer to reason about.

Note that `AGENTS.md` still describes the Vercel plus Supabase plus Fly stack in its Stack
section. That section is out of date; this file and `box-architecture.md` reflect reality.

## Where to look next

| Question | File |
|---|---|
| How is it deployed and operated | `box-architecture.md`, `box-deploy.md` |
| What was built in what order, and the ticket specs | `layers.md` |
| Current state and progress | `STATUS.md`, `PROGRESS.md` |
| What the tests guarantee | `test-contract.md` |
| Conventions and how agents work here | `AGENTS.md` |
