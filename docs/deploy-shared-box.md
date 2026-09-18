# Deploying onto a shared box

This is the runbook for putting Gold Rush on a server **we do not own exclusively** - other
services are already running on it, common ports (80, 443, 5432, 8080) may be taken, and we
are not free to open firewall holes or rebind whatever we like.

If instead you have a **fresh VPS that is ours alone**, use `docs/box-deploy.md` - it opens
80/443, lets Caddy hold the certificate, and is simpler. This document is the shared-box
variant of the same stack; the game engine, the security rule (the server decides every
outcome; the client never reports its own result), the schema bootstrap and the operator
pages are identical. Only the way traffic reaches the box and the way ports are bound differ.

Read once before you start: `docs/box-architecture.md` (topology and the server-decides rule),
`docs/box-deploy.md` (the owned-box runbook this one adapts), and the "Need from the owner"
list at the very bottom of this file.

## 0. The one thing that makes this different

On a shared box we cannot assume 80 or 443 are ours. So:

- **We bind no public port at all.** The origin path is a **Cloudflare Tunnel** (`cloudflared`),
  which dials out to Cloudflare and needs zero inbound ports. Nothing to fight over, no
  firewall change to request.
- **Every port we do publish is loopback-only and lives in one file** - `docker-compose.box.yml` -
  parameterised by `.env.box`. Change a port in one place, never in the compose base.
- **We never run `docker compose down -v`.** That wipes the MT5 data volume (a 12-minute
  reinstall plus a fresh broker login) and the database. See section 6.

## 1. Origin path: Cloudflare Tunnel (recommended) vs Caddy on a spare port

DNS for `goldrush.xchief.academy` is already an A record on Cloudflare, **proxied (orange
cloud) ON**. Two ways to give that hostname an origin on a box where 80/443 are likely taken:

|                                                                    | **Cloudflare Tunnel (cloudflared)** - recommended                                                   | Caddy on a spare high port                                                                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Inbound ports on the box                                           | **None.** cloudflared dials out on 443.                                                             | One public port, e.g. 8443 (a Cloudflare-supported origin HTTPS port).                                                   |
| Firewall on a box we do not control                                | **No change needed.**                                                                               | Must open the spare port to Cloudflare's IP ranges. Needs the owner.                                                     |
| Origin certificate                                                 | **None.** Caddy serves plain HTTP inside the compose network; the tunnel link is already encrypted. | Caddy needs a real cert. HTTP-01 needs inbound 80 (taken), so a Cloudflare **origin certificate** or DNS-01 is required. |
| Collision with the other services                                  | **Impossible** - we publish nothing.                                                                | Possible - we still hold a public port and depend on the firewall.                                                       |
| Can we stand it up before the owner sends the forbidden-port list? | **Yes** - needs no host port.                                                                       | No - we must know which spare port is free first.                                                                        |
| Moving parts                                                       | cloudflared process + its token.                                                                    | Public port + firewall rule + origin cert + Caddy ACME/DNS config.                                                       |

**Recommendation: the Tunnel.** On a shared box its single advantage is decisive - it publishes
nothing, so it cannot collide with the co-tenants and needs no firewall change we would have to
ask for. It also removes certificate handling from the box entirely. The one dependency it adds
(the cloudflared process and its token) is cheap and self-healing (`restart: unless-stopped`).

### TLS, end to end (Tunnel path)

1. **Player -> Cloudflare edge:** HTTPS with Cloudflare's certificate for
   `goldrush.xchief.academy`. Already handled by the proxied (orange-cloud) record.
2. **Cloudflare edge -> cloudflared:** Cloudflare's own encrypted tunnel transport. No cert of
   ours involved.
3. **cloudflared -> Caddy:** plain HTTP to `caddy:80` on the private compose network, never
   leaves the box.

Because the tunnel is independently encrypted, the zone's **SSL/TLS encryption mode**
(Flexible / Full / Full strict) governs only the _origin-pull_ path - the one Cloudflare uses
when it connects to your IP directly. The tunnel does not use that path, so the mode does not
gate it. **Leave the zone on Full (strict)** - its current setting. Do **not** switch it to
Flexible; that would only matter for a direct-IP origin and is the insecure option there.

WebSockets (`/ws`) pass through the tunnel unchanged - no extra Cloudflare setting on the free
plan.

## 2. The port map (one file, loopback-only)

All of our host bindings live in `docker-compose.box.yml` and resolve from `.env.box`. On the
recommended Tunnel path the stack publishes **no public port**; the only host bindings are
loopback, for a local smoke test or a one-time login.

| Container             | Container port | Host binding (default)            | Public?       | Change it via                          | What it is for                                                                                                 |
| --------------------- | -------------- | --------------------------------- | ------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `cloudflared`         | -              | none (outbound 443 to Cloudflare) | no inbound    | -                                      | The origin path.                                                                                               |
| `caddy`               | 80             | `127.0.0.1:8091`                  | loopback only | `BOX_CADDY_SMOKE_PORT`                 | `curl` smoke test on the box; cloudflared reaches Caddy as `caddy:80` over the compose network, not this port. |
| `server`              | 8787           | none                              | no            | -                                      | Reached only via Caddy on the compose network.                                                                 |
| `db` (postgres)       | 5432           | none                              | no            | (add a loopback bind only if you must) | Admin runs inside the container: `docker compose exec db psql ...`.                                            |
| `dozzle`              | 8080           | none                              | no            | -                                      | Reached via Caddy at `/logs`, scoped to our project only.                                                      |
| `mt5` (profile `mt5`) | 3001           | `127.0.0.1:8071`                  | loopback only | `BOX_MT5_VNC_PORT`                     | One-time MT5 first-login VNC UI. Off unless the `mt5` profile is used.                                         |

Every default above is either unpublished or bound to `127.0.0.1` on an uncommon high port, so
the only collision that is even possible on the shared box is another service already holding
that exact loopback port - and that is a one-line change in `.env.box`. **Once the owner sends
the forbidden-port list, the only action is to bump any `BOX_*` value that clashes.** No public
port is bound on this path at all, so the list does not block standing the stack up.

If the owner instead mandates the **Caddy-on-spare-port** path, the map changes to one public
bind - `0.0.0.0:${BOX_CADDY_HTTPS_PORT:-8443}:443` on Caddy - the firewall must open 8443 to
Cloudflare's ranges, Caddy must be given a Cloudflare origin certificate, and the zone stays on
Full (strict). That path is documented here only as the fallback; it is not the recommended one.

### How the port map is selected (and how the dev override is kept off the box)

`docker compose` auto-loads `docker-compose.override.yml` - which in this repo is the
**developer-machine** file (it rebinds Caddy to 8080 and publishes db/mt5). That must never
apply on the box. We pin the file set explicitly in `.env.box`:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.box.yml
COMPOSE_PROJECT_NAME=goldrush
```

Setting `COMPOSE_FILE` also switches off the automatic `docker-compose.override.yml` merge, so
the dev bindings cannot leak in. `deploy/deploy.sh` sources `.env.box` (`set -a`) before it runs
`docker compose`, so the deploy honours both. So every manual `docker compose` command you run
by hand picks it up too, add the same two lines to the deploy user's shell once:

```
echo 'export COMPOSE_FILE=docker-compose.yml:docker-compose.box.yml' >> ~/.bashrc
echo 'export COMPOSE_PROJECT_NAME=goldrush' >> ~/.bashrc
```

`COMPOSE_PROJECT_NAME=goldrush` namespaces our containers, network and volumes
(`goldrush_db`, `goldrush_pgdata`, `goldrush_default`, ...), which is what makes "prove it is
only us" in section 8 possible on a box full of other stacks.

## 3. Prerequisites and access

- **SSH** to the box as a user we may use, with our key installed (password login off). That
  user must be in the `docker` group. **On a shared box, membership of the `docker` group is
  effectively host-root** (it can mount the host filesystem and read every tenant's container),
  so this is a trust decision the owner has to make deliberately - see the owner list, item 2.
- **Docker Engine + the Compose plugin** already present on the box (`docker compose version`).
  We do not install Docker on a box we do not own; if it is missing, ask the owner.
- **cloudflared needs nothing installed on the box** - it runs as a container in our stack.
- **A Cloudflare Tunnel** created in the `xchief.academy` Zero Trust account, and its **token**
  (see section 4, step 2).
- **The code**, pulled by the box. Either a read-only deploy key on
  `github.com/AIT-ERP/xChief-Gold-Rush` (as `docs/box-deploy.md` section 3 describes) or a
  branch we push and the box tracks (`DEPLOY_BRANCH`, default `dev`).
- **Secrets** for `.env.box` (section 4, step 3).

## 4. First deploy

All commands run on the box as the deploy user, in the checkout directory (this guide assumes
`/opt/goldrush`, as `deploy/install.sh` clones it).

### 1. Get the code and the env file onto the box

Follow `docs/box-deploy.md` sections 2-3 to run `deploy/install.sh` up to the point where it
creates `.env.box` from `.env.box.example`. Stop there - do not deploy yet. (On a shared box,
`install.sh`'s `ufw` step opens 22/80/443; if the owner runs their own firewall, skip or adapt
that - the Tunnel path needs none of 80/443 open. Confirm with the owner before touching `ufw`
on a shared box, item 2.)

### 2. Create the Cloudflare Tunnel and point the hostname at it

In the Cloudflare dashboard for `xchief.academy`:

1. **Zero Trust -> Networks -> Tunnels -> Create a tunnel -> Cloudflared.** Name it
   `goldrush-box`. The dashboard shows an **install token** (a long `eyJ...` string). Copy it -
   that is `CLOUDFLARED_TUNNEL_TOKEN`. You do not run the install command it shows; our compose
   runs cloudflared for you.
2. In the tunnel's **Public Hostnames -> Add a public hostname:**
   - Subdomain `goldrush`, domain `xchief.academy`, path empty.
   - Service **Type** `HTTP`, **URL** `caddy:80`.
   - Save. Cloudflare updates the DNS for `goldrush.xchief.academy` to route through the tunnel
     (a proxied CNAME to `<tunnel-id>.cfargotunnel.com`), superseding the old A record. Remove
     the stale A record if it lingers - a name carries one proxied record.
3. Leave the zone **SSL/TLS mode on Full (strict)** (section 1). Nothing else to change there.

### 3. Fill in `.env.box`

Fill every value as `docs/box-deploy.md` section 3 describes (`POSTGRES_PASSWORD`,
`DATABASE_URL`, `FINNHUB_TOKEN`, `PLAYER_TOKEN_SECRET`, `ELASTIC_API_KEY`, `OTP_SENDER`,
`DOZZLE_PASSWORD_HASH`, optional alerts). Then add the shared-box lines:

```
# Shared-box origin + file selection (section 2 of docs/deploy-shared-box.md)
COMPOSE_FILE=docker-compose.yml:docker-compose.box.yml
COMPOSE_PROJECT_NAME=goldrush
CLOUDFLARED_TUNNEL_TOKEN=eyJ...              # from step 2
SITE_ADDRESS=goldrush.xchief.academy        # the server's real origin (Caddy is forced to :80 by the overlay)

# Optional port overrides - only if a default loopback port is already taken on the box
# BOX_CADDY_SMOKE_PORT=8091
# BOX_MT5_VNC_PORT=8071
```

`SITE_ADDRESS` stays the real domain: the game server reads it for Layer 2 origin pinning. The
overlay forces only _Caddy's_ public address to `:80`, so Caddy serves HTTP internally and never
tries (and fails) to fetch a certificate.

### 4. Bring the stack up

```
deploy/deploy.sh
```

This pulls the deploy branch, builds the client bundle inside Docker, and runs
`docker compose --env-file .env.box up -d --build`. Because `COMPOSE_FILE` is set, that resolves
to `docker-compose.yml` + `docker-compose.box.yml` (never the dev override). It starts db,
server, caddy, dozzle and cloudflared, applies the schema once (see section 6), and waits for
`/health` on the loopback smoke port.

For the second price source (MT5), add `--profile mt5` and complete the one-time login per
`docs/mt5-feed.md`; it is not required - the server runs on Finnhub with PAXG fallbacks
otherwise, or on a relay via `FEED_RELAY_WS`.

### 5. Smoke test

From the box (loopback, no public port needed):

```
curl -fsS http://127.0.0.1:8091/health          # short JSON => server alive
curl -fsS http://127.0.0.1:8091/status | jq .    # feed.source, db, coupons, connections, safe_mode
docker compose --env-file .env.box logs cloudflared | tail   # look for "Registered tunnel connection"
```

Then from anywhere, through Cloudflare:

```
curl -fsS https://goldrush.xchief.academy/health
```

Confirm in a browser: open `https://goldrush.xchief.academy`, play one round (the price moves,
a round issues, resolves server-side, the score updates), open `/ops` and check the rows are
green, and in Cloudflare Zero Trust confirm the tunnel shows **HEALTHY**. On `/status`,
`feed.source` should name the live source (`OANDA` / `IC Markets` / `OKX` / `Binance` / `MT5`),
not be null.

## 5. Health and monitoring (already built)

Nothing new to install; the Tunnel serves the same operator surface as the owned box:

- **`/health`** - liveness, short JSON.
- **`/status`** - one JSON snapshot: `feed.source`, price age, db reachable, rounds/min and
  /day, coupons remaining, connected browsers and kiosks, `safe_mode: {level, reason}`. No
  secrets.
- **`/ops`** - the page to bookmark: `/status` as a red/green table, refreshed every 5 s.
- **`/logs`** - Dozzle live container logs, password-gated (`DOZZLE_PASSWORD_HASH`) and, on this
  shared box, **scoped to our project only** by the overlay's `DOZZLE_FILTER`, so it cannot show
  the co-tenants' containers. Put **Cloudflare Access** in front of `/logs` as well, as
  `docs/box-deploy.md` recommends.
- **Alerts** - `ALERT_WEBHOOK_URL` and/or the Telegram bot fire on feed-silent, restart,
  safe-mode change, IP block, low coupon stock, deploy done/failed. Unchanged.

**The owner's "is it up" check:** open `https://goldrush.xchief.academy/ops`. All rows green =
up. Plus, once, the Cloudflare Zero Trust tunnel status = HEALTHY.

## 6. Redeploy, schema, rollback - what is safe to reset

### Code-only redeploy (the normal case)

Push to the deploy branch (the cron picks it up within a minute) or run `deploy/deploy.sh` by
hand. It rebuilds and recreates only what changed; named volumes (`goldrush_pgdata`,
`goldrush_mt5_data`, `caddy_data`) persist. The schema step is a no-op (see below). Smoke-test
per section 4.5.

### Schema-changing redeploy - stop and read (gap G7 / ticket D4)

`server/migrate.mjs` records `db/schema.sql` by a **fixed name** in `schema_migrations` and
**skips it on every later boot**. So if a deploy changes `db/schema.sql`, the change does **not**
reach the existing database - the old tables stay (seen locally: `public.settings does not
exist` after a schema merge). And `db/schema.sql` is written from scratch, not idempotently
(plain `create table` / `create function` / `alter table`), so it cannot simply be re-run
against a populated database.

Until **ticket D4 (gap G7)** lands an idempotent apply or a real migrations folder, **no
schema-changing deploy may hit this box unattended.** The safe interim path:

1. The developer ships the schema change as an **explicit, idempotent** DDL snippet
   (`create ... if not exists`, `create or replace function`, guarded `alter table`).
2. Apply it by hand, in a transaction, against the live db - never by recreating the volume:
   ```
   docker compose --env-file .env.box exec -T db psql -U postgres -v ON_ERROR_STOP=1 < change.sql
   ```
3. Restart the server so it picks up any code that depends on it:
   ```
   docker compose --env-file .env.box restart server
   ```

Never `docker compose down -v`, and never delete the `schema_migrations` row to "force a
re-run" while `db/schema.sql` is non-idempotent - a partial re-apply against live data is worse
than the drift. Close D4 first; then this whole subsection collapses back into "just deploy".

### The rule that protects the MT5 volume (gap G12)

**Never `docker compose down -v` on this project.** `-v` deletes the named volumes, including
`goldrush_mt5_data` (the MT5 terminal install and its saved broker login - a 12-minute rebuild
plus a fresh first-login) and `goldrush_pgdata` (every player, score and coupon).

- To restart everything, `down` **without** `-v` is safe (volumes survive):
  ```
  docker compose --env-file .env.box down
  docker compose --env-file .env.box up -d
  ```
- To reset **only** the database (rare, and it destroys all game data - use only on a corrupt
  dev database, never in the campaign):
  ```
  docker compose --env-file .env.box rm -sf db
  docker volume rm goldrush_pgdata
  docker compose --env-file .env.box up -d
  ```
  This leaves `goldrush_mt5_data` untouched. There is no path in this runbook that removes the
  MT5 volume.

### Rollback

```
deploy/rollback.sh <commit>
```

Checks out that commit and redeploys it, and stays there (the next cron tick will not move it
forward). **Caveat:** rollback does not undo a schema change - there are no down-migrations. A
rollback across a schema-changing deploy is not safe until D4 lands; roll code back, and treat
the database change as forward-only.

## 7. If something else on the box breaks - proving our stack is isolated

Because `COMPOSE_PROJECT_NAME=goldrush` namespaces everything, "is this us?" is answerable:

- **Only our containers:**
  ```
  docker compose --env-file .env.box ps
  ```
  Everything with a `goldrush_` prefix is ours; nothing else is.
- **We publish nothing public:** confirm no listener of ours is on 80/443 or any public port -
  our only host binds are loopback:
  ```
  ss -ltnp | grep -E '127\.0\.0\.1:(8091|8071)'   # our loopback binds
  ss -ltnp | grep -E ':(80|443)\b'                # should be the OTHER services, never ours
  ```
  If 80/443 break on the box, it is not us - we bind neither.
- **Our footprint:**
  ```
  docker stats $(docker compose --env-file .env.box ps -q)
  ```

What we **do** share with the co-tenants: the host Docker daemon, kernel and disk. So:

- **Never** `docker system prune -a` or `docker compose down -v` - both reach beyond our stack
  or destroy our volumes.
- Keep our logs from filling the shared disk: `mt5` already caps its json-file logs; if disk is
  tight, add the same `logging` cap to the other services in `docker-compose.box.yml`.
- `/logs` is scoped to our project (`DOZZLE_FILTER`), so we do not expose the co-tenants' logs.

## Need from the owner before first deploy

1. **The exact occupied / forbidden host-port list** - and whether we may bind _any_ public
   port at all, or must be Tunnel-only. On the recommended Tunnel path we publish nothing, so
   the only use of this list is to move a clashing **loopback** default (`8091`, `8071`); but we
   need it confirmed before we bind anything.
2. **SSH and Docker access:** the box IP/hostname and SSH port, the deploy user we may use with
   our key installed, and explicit confirmation that **we may add that user to the `docker`
   group** (which on a shared box is host-root-equivalent) - or an agreed alternative (rootless
   Docker, a scoped setup). Also: may we run `ufw`, or does the owner manage the firewall?
3. **Cloudflare Tunnel:** approval of the Tunnel path, access to the `xchief.academy` Zero Trust
   account, a created tunnel named `goldrush-box` and its **token** (`CLOUDFLARED_TUNNEL_TOKEN`),
   and confirmation we may point `goldrush.xchief.academy` at that tunnel (replacing the current
   proxied A record). If they instead mandate Caddy-on-spare-port: which public port, the
   firewall opening to Cloudflare's ranges, and the origin-cert choice.
4. **Secrets for `.env.box`:** `FINNHUB_TOKEN`, `ELASTIC_API_KEY` + verified `OTP_SENDER`, and
   either a `/logs` password (we hash it into `DOZZLE_PASSWORD_HASH`) or a decision to use
   Cloudflare Access for `/logs`. Optional: `ALERT_WEBHOOK_URL` and/or Telegram
   `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`; MT5/MetaApi credentials if the broker feed is in
   scope; Instagram app credentials if that reward is going live. (`POSTGRES_PASSWORD`,
   `PLAYER_TOKEN_SECRET` and the Dozzle hash we generate on the box.)
5. **Code access and branch:** a read-only deploy key on
   `github.com/AIT-ERP/xChief-Gold-Rush`, or a branch we push that the box tracks, and which
   branch that is (`DEPLOY_BRANCH`, default `dev`). Plus confirmation that **gap G7 / ticket D4
   (idempotent schema apply) is closed** before any schema-changing deploy is sent to this box -
   until then, schema changes are hand-applied per section 6.

---

Related: `docs/box-deploy.md` (owned-box runbook and the shared ops/monitoring detail),
`docs/box-architecture.md` (topology, the server-decides rule), `docs/admin-requirements-box.md`
(what was originally asked of the box admin), `docker-compose.box.yml` (the one place our port
map and the Tunnel live).
