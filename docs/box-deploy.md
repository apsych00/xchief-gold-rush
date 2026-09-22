# Deploying the box (for a non-engineer)

One server ("the box") runs the whole game: the website, the kiosk screens, the
price feed and the database. This document takes you from an empty VPS to
`https://your-domain.com` serving the game, step by step. Copy each block of
commands into the terminal and press Enter. You do not need to understand them.

What runs on the box (handled for you by `docker compose`):

- **db** - the Postgres database. Not reachable from the internet, only by the other two.
- **server** - the game server (Node). Creates the database tables by itself the first time it starts.
- **caddy** - the public front door: serves the website files, forwards the game traffic to the server, and gets a free TLS (https) certificate for your domain automatically.

Everything after the one-time install is four scripts, all in `deploy/`:

| Script                        | When                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `deploy/install.sh`           | Once, on a brand new box.                                                                               |
| `deploy/deploy.sh`            | Manually, any time you want to deploy right now. Also what a push triggers automatically.               |
| `deploy/autodeploy.sh`        | Never by hand - a cron job runs it every minute and it only acts when there is something new to deploy. |
| `deploy/rollback.sh <commit>` | When a deploy needs to be undone.                                                                       |

Node is never installed on the box. The website is built **inside Docker** by `deploy/deploy.sh` every time it runs, so the box can never end up serving a bundle built on the wrong machine.

## Before you start, you need

- A VPS (a small virtual server) with **4 vCPU / 8 GB RAM**, **Ubuntu 24.04**, and root access (SSH key, not password). Any provider works (Hetzner, DigitalOcean, OVH). Roughly 20-30 EUR/month.
- A domain, with a free [Cloudflare](https://cloudflare.com) account managing its DNS (e.g. `goldrush.xchief.com`).
- The campaign's API keys: Finnhub token, Elastic Mail API key, and the sender email address.
- A copy of this repository on your own computer, checked out on the campaign branch (ask the developer which branch that is - `deploy/install.sh` defaults to `main`).
- A read-only **deploy key** for the box. Ask the developer for it; `deploy/install.sh` tells you exactly where it goes and will not proceed without it. This is deliberate - the box only ever gets read access to the code, never write access.

## 1. Create the VPS

At your provider, create a server with the Ubuntu 24.04 image and the size
above. Set a strong root password. Note its public IP address, e.g.
`188.6.6.6`. Then connect from your own computer:

```
ssh root@188.6.6.6
```

(all following commands run on the box, as root)

## 2. Get `deploy/install.sh` onto the box

The box does not have the code yet, so copy just this one script over first,
from your own checkout:

```
scp deploy/install.sh root@188.6.6.6:/root/install.sh
```

## 3. Run the installer

```
ssh root@188.6.6.6
bash /root/install.sh
```

It installs Docker (official script), creates a dedicated `deploy` user, and
then stops to ask you for the deploy key:

```
No deploy key found at /home/deploy/.ssh/id_ed25519.
...
```

Get that key from the developer (it is read-only - it can pull the code, it
cannot push to it) and copy it into place exactly as the script says, for
example:

```
scp goldrush-deploy root@188.6.6.6:/home/deploy/.ssh/id_ed25519
```

Then run `bash /root/install.sh` again. This time it clones the repository to
`/opt/goldrush`, and stops a second time to ask you to fill in `.env.box`:

```
nano /opt/goldrush/.env.box
```

`nano` is a text editor: type to edit, Ctrl+O then Enter to save, Ctrl+X to
exit. Fill in every line that has no value (see the comment above each in the
file):

| Variable               | What to put                                                                                                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`    | Invent one: run `openssl rand -hex 24` on the box and paste the result.                                                                                                                                                                                                |
| `DATABASE_URL`         | Same value as above, between the last `:` and `@db`. Example with password `abc123`: `postgresql://postgres:abc123@db:5432/postgres`                                                                                                                                   |
| `SITE_ADDRESS`         | Your domain, e.g. `goldrush.xchief.com`.                                                                                                                                                                                                                               |
| `FINNHUB_TOKEN`        | Your Finnhub token (finnhub.io, free tier).                                                                                                                                                                                                                            |
| `PLAYER_TOKEN_SECRET`  | Run `openssl rand -hex 32` and paste the result.                                                                                                                                                                                                                       |
| `ELASTIC_API_KEY`      | Your Elastic Mail API key.                                                                                                                                                                                                                                             |
| `OTP_SENDER`           | The verified sender address, e.g. `no-reply@goldrush.xchief.academy`.                                                                                                                                                                                                  |
| `DOZZLE_PASSWORD_HASH` | Password for the `/logs` live-log page. Generate it with `docker run --rm caddy:2 caddy hash-password --plaintext '<your password>'`, then paste the output here with every `$` doubled (`$2a$14$abc` becomes `$$2a$$14$$abc`) - otherwise Docker silently mangles it. |
| `ALERT_WEBHOOK_URL`    | Optional. Where the feed-silent / server-restarted alert goes - see section 10 below.                                                                                                                                                                                  |
| `TELEGRAM_BOT_TOKEN`   | Optional. Bot token from @BotFather for Telegram alerts - see section 10 below.                                                                                                                                                                                        |
| `TELEGRAM_CHAT_ID`     | Optional. The Telegram group chat id (a negative number) - see section 10 below.                                                                                                                                                                                       |

`PORT` can stay `8787`. Never share or commit `.env.box`.

Run `bash /root/install.sh` a third time. It now finishes: it installs the
cron job that checks for new commits every minute (section 6 below), and
opens the firewall to exactly 22, 80 and 443.

## 4. Point the domain at the box

In Cloudflare, for your domain: add an **A record** named `goldrush` (or
whatever subdomain you chose in `SITE_ADDRESS`) with the box's IP address
(`188.6.6.6`), **Proxy status: Proxied (ON)**, and set SSL/TLS mode to
**Full**. Wait a minute for it to take effect. This is the only DNS change
needed; Caddy handles the https certificate from here.

## 5. First deploy

As the `deploy` user (not root):

```
ssh deploy@188.6.6.6
cd /opt/goldrush
deploy/deploy.sh
```

This one command builds the website inside Docker (no Node on the box, and
the build always uses `.env.production` so it can never pick up a developer's
local settings), starts the database, the game server and Caddy, waits up to
a minute for the server to answer, and prints its status. The first run
downloads everything (a few minutes); after that it is quick. Run it again
any time - a second run with nothing new to deploy is a safe no-op.

## 6. Check it works

Open `https://<your-domain>/health` in a browser. A short JSON response means
the game server is alive. Then open the homepage and play a round.

## 7. Create the kiosk screens

For each physical kiosk device, once: set `KIOSK_OPEN_PROVISION=1` in
`.env.box`, then open `https://<your-domain>/kiosk` full-screen in Chrome
kiosk mode. The device provisions its own identity on first load and keeps it
in local storage, so a reload, a browser crash or a reboot resumes the same
session - there is no launch URL to generate or distribute (ticket S3 removed
the older `/?k=<secret>` flow entirely).

Compromised or misbehaving device? Find its label and revoke it:

```
npm run box:kiosk:list
npm run box:kiosk:revoke -- open-20260101-ab12
```

The device notices on its own next reconnect attempt, re-provisions a fresh
identity, and carries on - no need to touch the device itself unless you also
want to clear its browser storage.

Other admin scripts (see `scripts/README.md`):
`npm run box:kiosk:list`, `npm run box:coupons:export > coupons.csv`,
`npm run box:coupons:load -- codes.txt` (the file must be in the `goldrush`
folder), `npm run box:otp:peek someone@example.com` (dev only).

## The open kiosk route in detail (ticket K1)

`KIOSK_OPEN_PROVISION` and `KIOSK_OPEN_MAX` (used above) are the two environment switches in
`.env.box` that control `/kiosk`:

- `KIOSK_OPEN_PROVISION` - set to `1` during the exhibition to enable `/kiosk`. Set it back to
  `0` and restart the server after the exhibition.
- `KIOSK_OPEN_MAX` - hard cap on the total number of active auto-provisioned open kiosks (default 100).
  Once the cap is reached, `/kiosk` refuses new devices until old ones are removed.

Turn it off after the exhibition:

```
# edit /opt/goldrush/.env.box and set KIOSK_OPEN_PROVISION=0
deploy/deploy.sh
```

Decommissioning the auto-provisioned kiosks means deleting the rows whose labels start with
`open-` (they are already excluded from the normal kiosk list once revoked):

```
docker compose --env-file .env.box exec db psql -U postgres \
  -c "delete from public.kiosks where label like 'open-%';"
```

`/status` reports `kiosks.open` and `kiosks.seeded` so you can watch the count.

## 8. Monitoring

Three read-only views, all served by Caddy - none of them need SSH:

- **`https://<your-domain>/status`** - one JSON snapshot of what the game server sees right
  now: is a price source connected, how old is the last tick, is the database reachable,
  how many rounds settled in the last minute and the last day, how many $100 coupons are
  left, how many browsers and kiosks are connected. No secrets, no player data - safe to
  open in any browser, share in a screenshot, or point a monitoring tool at.
- **`https://<your-domain>/ops`** - a plain page built on top of `/status`: the same facts as
  a small table, refreshed every 5 seconds, red or green per row. This is the page to bookmark.
- **`https://<your-domain>/logs`** - live logs from every container (Dozzle), for the
  developer diagnosing something the other two pages do not explain. Password-protected: the
  password is whatever plaintext you hashed into `DOZZLE_PASSWORD_HASH` in step 3. In
  production, ask the developer to put **Cloudflare Access** in front of `/logs` as well (or
  instead) - it is the more robust option and does not depend on a shared password.

### Alerts to your phone (optional but recommended)

Set `ALERT_WEBHOOK_URL` in `.env.box` (edit it any time, then run `deploy/deploy.sh` again to
pick up the change) and the game server will send a short message when the price feed goes
silent for a full minute, or whenever it restarts.
The easiest destination is [ntfy.sh](https://ntfy.sh): pick a topic name nobody else will
guess, e.g. `xchief-goldrush-a7f3d1`, install the ntfy app on your phone (iOS/Android, free,
no account) and subscribe to that topic. Set:

```
ALERT_WEBHOOK_URL=https://ntfy.sh/xchief-goldrush-a7f3d1
```

A Slack or Discord incoming webhook URL also works - paste it in the same variable. Alerts
for the same problem are sent at most once every 5 minutes, so a real outage does not flood
your phone.

#### Telegram bot (alternative or in addition to the webhook)

You can also have alerts go to a Telegram group. This uses the same bot for server events
and for deploy done/failed messages.

1. Create the bot with [@BotFather](https://t.me/botfather):
   - Send `/newbot` and follow the prompts.
   - Copy the bot token (it looks like `123456:ABC...`).
2. Add the bot to the operator group and give it permission to send messages.
3. Find the group chat id:
   - Post any message in the group.
   - Open `https://api.telegram.org/bot<your-bot-token>/getUpdates` in a browser.
   - Look for `"chat":{"id":-123456789` - that negative number is `TELEGRAM_CHAT_ID`.
4. Fill the two lines in `.env.box`:

```
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=-123456789
```

Run `deploy/deploy.sh` again to pick up the change. To verify the bot from the box:

```
npm run box:alert-test -- server_started
```

You should see the message in the Telegram group immediately. The server sends an alert for
restart, feed silence/recovery, safe-mode changes, blocked IPs, low coupon stock and exhausted
pool. Deploy success and failure are also posted through the same bot by `deploy/deploy.sh`.

## 9. Take a snapshot

In your provider's control panel, take a **snapshot/backup image** of the
VPS now that everything works. Name it `goldrush-baseline`. Do this again
after any big change. It is the "undo button" for the whole box.

Done. The campaign runs itself from here.

---

## Instagram follow reward (ticket K3)

The "Follow on Instagram" task is built and ready, but it only activates once the BoxAPI token is added. Until then `/status` reports `instagram: "not_configured"` and the task shows "Coming soon" (it does not crash).

### How the follow is verified

The player enters their own Instagram handle, is sent to Instagram (app deep link, falling back to the web profile) to follow `@xchief`, then taps "I followed, check". The server verifies the follow through the BoxAPI Instagram data API (docs/boxapi-instagram-data-api.md): it resolves our own account's numeric id (`user/get_info_by_username`, cached in memory for 24 h), resolves the player's id the same way, and reads the player's following list (`user/get_following`) to look for us. The client never asserts the follow - the server reads BoxAPI and decides. The reward is released through the same `release_task_reward` path as every other task, so it is granted once per player, per device and per verified email (ticket B13). A handle can be claimed by one player only.

A private account cannot be checked (its following list is hidden); the player is asked to make it public for a moment or see the booth staff. An unknown handle asks the player to check the spelling.

### When the BoxAPI token arrives

1. Edit `.env.box` and fill in the Instagram follow reward lines:
   - `BOXAPI_TOKEN` - the BoxAPI Bearer token (from the BoxAPI dashboard, https://boxapi.ir).
   - `BOXAPI_BASE` - the API base URL; leave it at the default `https://boxapi.ir/api/instagram/` unless BoxAPI moves it.
   - `INSTAGRAM_HANDLE` - our own account handle without the `@`, e.g. `xchief`.
   - `INSTAGRAM_PROFILE_URL` - the web profile the player is sent to, e.g. `https://www.instagram.com/xchief/` (optional; derived from `INSTAGRAM_HANDLE` when left empty).
2. Run `deploy/deploy.sh` to restart the server with the new env.
3. Smoke test: open the coins screen, tap "Follow on Instagram", enter a handle that follows `@xchief`, follow, then tap "I followed, check". The task row should show "Claimed" and the balance should increase by the task reward (default 300).
4. Check `https://<your-domain>/status` - the `instagram` field should now read `"configured"`.

---

## When something breaks

Stay calm and go in this order. All commands run in
`/opt/goldrush` on the box, as the `deploy` user (`ssh deploy@188.6.6.6` first).

**Read the logs** - what the game server saw, live (Ctrl+C to stop watching):

```
docker compose --env-file .env.box logs -f server
```

**See what is running.** All three should say `Up` (the db and server may say
`(healthy)`):

```
docker compose --env-file .env.box ps
```

**Restart the game server** - fixes most oddities, takes seconds, players just
reload the page (rounds in flight at that exact second are voided, which is
correct):

```
docker compose --env-file .env.box restart server
```

**Restart everything:**

```
docker compose down && docker compose --env-file .env.box up -d
```

**The website loads but the price never moves:** the feed sources are down or
`FINNHUB_TOKEN` is wrong. The game falls back to crypto-market gold prices on
its own; check `docker compose --env-file .env.box logs -f server` for feed messages.

**The browser shows a TLS/https error:** the domain is not pointing at this
box (step 4), or Caddy is still getting its certificate. `docker compose --env-file .env.box logs
caddy` shows what it is doing.

**A deploy failed.** Read the log (below), fix whatever it points at, then run
`deploy/deploy.sh` again by hand - it is safe to retry.

## Normal updates: push to deploy

Once installed, the box checks for new commits on the campaign branch every
minute by itself (a cron job runs `deploy/autodeploy.sh`). The marketing lead
or the developer pushes to that branch, and within a minute the box notices,
rebuilds the website inside Docker, rebuilds the server if it changed, and
restarts only what needs restarting. Nothing to do on the box for this - just
push.

## Manual deploy

To deploy right now instead of waiting for the next cron tick, or to deploy a
change you know has not landed on the campaign branch's remote head yet:

```
ssh deploy@188.6.6.6
cd /opt/goldrush
deploy/deploy.sh
```

Same command as the first deploy (section 5 above). It always pulls the
latest commit of the campaign branch first, then rebuilds and restarts.

## Database migrations

A database change (a function body, a default, a column) that lands in `db/schema.sql` and a
file under `db/migrations/` needs nothing extra from you - it is just another push. The deploy
sequence is the same one above (`deploy/deploy.sh`, or the cron autodeploy): rebuild, restart the
server container, and on that container's own boot, before the game server ever starts listening,
it runs every migration nobody has applied to this database yet. A deploy that cannot migrate
fails outright rather than starting a server against a half-migrated database - watch for that the
same way you would watch for any other deploy failure (see "Reading the deploy log" above).

This removes every hand-patch step that used to follow a schema change. Before this system
existed, editing `db/schema.sql` changed nothing on a database that had already booted once -
production included - and someone had to notice the drift and run the SQL by hand on the box.
That already happened three times: the leaderboard page size, the OTP code length, and the kiosk
streak target all had to be patched manually after a deploy that looked successful. None of that
is needed anymore; a schema change that ships with its migration file applies itself.

## If the box is attacked

The threat this section answers: a script spawning many headless browsers or raw sockets, from
one IP or (more likely, since a single IP is already handled automatically - see below) from many
rotating IPs at once. Two layers, working together: the server's own **safe mode**, and a
Cloudflare setting you flip by hand as the last resort.

### Telling an attack from a busy booth

One IP hammering the game is already handled without you doing anything: the server blocks any
single IP that opens too many sockets or connections for 15 minutes on its own (ticket S2). What
is left for you to judge is the harder case - a flood spread across many IPs, which looks, at a
glance, like "a lot of people are playing." The tell:

- **A busy booth:** kiosk rounds keep running steadily. Web sign-ups (new anonymous players)
  rise too, but roughly in proportion to the crowd you can see.
- **An attack:** kiosk rounds continue exactly as normal (a script has no reason to touch the
  kiosks), but the number of **new anonymous web players** and/or **open connections** spikes far
  out of proportion to anyone actually standing at the booth.

`/ops` shows both: "Rounds / minute" (kiosk activity is part of this) and, once safe mode has
already reacted, a banner. If you are unsure before the banner appears, that spike in anonymous
sign-ups with flat kiosk activity is the signal to act early rather than wait for it.

### What you see on `/ops`

A banner above the table, hidden while everything is normal:

- **Amber, "Safe mode: GUARDED (...)"** - new anonymous players (web only; kiosks are never
  affected) are being turned away with a short retry hint, OTP request limits are halved, and the
  leaderboard updates less often. Anyone already playing keeps playing exactly as before.
- **Red, "Safe mode: LOCKED (...)"** - guarded's rules, plus every brand-new web connection is
  refused and disconnected outright (kiosks still unaffected). Sockets already open - anyone
  mid-game - are completely untouched.

The text in parentheses is why: `manual` (you set it), `restored` (the level survived a restart),
or `auto:connections` / `auto:anon_players` / `auto:blocklist` (which automatic threshold
tripped - see `server/safemode.js` for the exact numbers, chosen well above normal expo traffic).
`/status` carries the same two fields as `safe_mode: { level, reason }`, if you ever want it from
a script instead of the page.

### The one command to lock, and the one to return to normal

```
ssh deploy@188.6.6.6
cd /opt/goldrush
npm run box:safe-mode -- locked
```

and to bring it back:

```
npm run box:safe-mode -- normal
```

The server picks either up within 5 seconds; nothing is restarted, nobody already playing is
disconnected. Left alone, the server also does this by itself: it escalates one level on its own
when the numbers above trip, and steps back down on its own after 10 minutes of genuinely quiet
traffic - so a manual `locked` you forget about does not stay locked forever, but re-running the
command holds it if you want to keep it that way while you sort out the Cloudflare side below.

### Cloudflare: the edge in front of the box

Two things should already be on from setup (`docs/admin-requirements-box.md`): **Bot Fight
Mode** and a **rate-limiting rule** on `/ws` and `/api/*` (60 requests per minute per IP - this is
what actually stops a rotating-IP flood from ever reaching the server in the first place; safe
mode above is what happens to whatever gets through). If an attack is still hurting the game after
both of those and safe mode are doing their job, the manual last resort:

1. Log into Cloudflare, select the `xchief.academy` zone.
2. **Security** → **Settings**.
3. Set **Security Level** to **I'm Under Attack**.

This puts a short JavaScript check in front of every new visitor before they ever reach the box -
a few seconds of "checking your browser," once, on first visit. A player already mid-game keeps
their socket; only new arrivals see the check. Set **Security Level** back to its previous value
(typically "Medium") once things have calmed down - "I'm Under Attack" adds a delay every new
visitor pays, worth it only while genuinely under one.

## Rollback

If a deploy broke something, move the box back to a commit that worked:

```
ssh deploy@188.6.6.6
cd /opt/goldrush
git log --oneline -10          # find the commit to go back to
deploy/rollback.sh <commit>
```

This checks out that exact commit and deploys it. The box stays on it - the
next cron tick will not silently move it forward again - until someone runs
`deploy/deploy.sh` by hand to return to the branch tip.

## Reading the deploy log

Every automatic check and every deploy, successful or not, adds one line to:

```
tail -f /var/log/goldrush-deploy.log
```

"Up to date" lines are the cron job confirming nothing changed. A line
starting with a commit range means it found new commits and deployed them;
the line after it says whether that deploy succeeded or failed. If a deploy
fails, everything `deploy.sh` printed is in the log right above the failure
line.

## Daily habits

**The 60-second morning check:**

1. Open `https://<your-domain>/ops`.
2. All six rows should be green. If "Feed connected" or "Price age" is red, wait a minute
   and refresh once - the feed reconnects on its own; if it is still red, restart the server
   (see "When something breaks" above). If "Database" is red, restart everything.
3. If "Coupons remaining" is red, tell the developer - the pool is empty and needs
   reloading (`npm run box:coupons:load`).
4. "Rounds / minute" at zero outside booth hours is normal. During booth hours it should not
   sit at zero for more than a few minutes with visitors in front of a kiosk.
5. Play one round yourself on the homepage to confirm the whole path end to end.

That is the whole daily routine. No SSH needed unless something above is red.

- Before real prizes go live, ask the developer to enable nightly database backups (planned, ticket S6).
- **Log a player out everywhere.** A web player's token is good for 30 days and renews itself
  while they keep playing (docs/layers.md C3a); there is no button for signing one out. If you
  ever need to (a lost device, a support request), find their id and revoke it from the box:
  ```
  docker compose --env-file .env.box exec db psql -U postgres \
    -c "select id from public.players where email = 'player@example.com';"
  docker compose --env-file .env.box exec db psql -U postgres \
    -c "select public.revoke_player_sessions('<the id from above>');"
  ```
  Every token already issued for that player stops working on its next use; they simply become
  a fresh anonymous player next time they connect. Their score and history are untouched.
- **Adjust tournaments.** The campaign is a series of tournaments (ticket B1); adding, moving
  or removing one is SQL only - never a code change or a restart. The server reads the
  `tournaments` table live and the leaderboard push throttles to at most once a second, so a
  change here shows up within a second of the query committing. Two tournaments' windows may
  never overlap - the database refuses the `insert`/`update` below with an exclusion-constraint
  error if they would.
  ```
  # Add a new tournament
  docker compose --env-file .env.box exec db psql -U postgres -c "
    insert into public.tournaments (id, title, starts_at, ends_at, prize_title, prize_image, broker_bonus)
    values ('t3', 'Gold Rush Week 3', '2026-09-24 00:00:00+04', '2026-09-28 00:00:00+04',
            'First prize', '/prizes/week3.png', null);"

  # Move a tournament's dates, prize or broker bonus
  docker compose --env-file .env.box exec db psql -U postgres -c "
    update public.tournaments set ends_at = '2026-09-25 00:00:00+04' where id = 't3';"

  # Remove a tournament that has not started yet (a running or past one carries settled rounds
  # and tournament_scores through its id - foreign keys refuse the delete; edit its dates
  # instead, or leave it as the historical record)
  docker compose --env-file .env.box exec db psql -U postgres -c "
    delete from public.tournaments where id = 't3';"
  ```
  Dates are `timestamptz`; write them in the venue's local time with its UTC offset (Dubai is
  `+04`, no DST) exactly as `db/seed.sql`'s own tournament rows do, so `now() at time zone` never
  has to be reasoned about by whoever runs the one-liner.
