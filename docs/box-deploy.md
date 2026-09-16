# Deploying the box (for a non-engineer)

One server ("the box") runs the whole game: the website, the kiosk screens, the
price feed and the database. This document takes you from an empty VPS to
`https://your-domain.com` serving the game, step by step. Copy each block of
commands into the terminal and press Enter. You do not need to understand them.

What runs on the box (handled for you by `docker compose`):

- **db** - the Postgres database. Not reachable from the internet, only by the other two.
- **server** - the game server (Node). Creates the database tables by itself the first time it starts.
- **caddy** - the public front door: serves the website files, forwards the game traffic to the server, and gets a free TLS (https) certificate for your domain automatically.

## Before you start, you need

- A VPS (a small virtual server) with **4 vCPU / 8 GB RAM**, **Ubuntu 24.04**, and the root password. Any provider works (Hetzner, DigitalOcean, OVH). Roughly 20-30 EUR/month.
- A domain, with a free [Cloudflare](https://cloudflare.com) account managing its DNS (e.g. `goldrush.xchief.com`).
- The campaign's API keys: Finnhub token, Elastic Mail API key, and the sender email address.
- Access to the GitHub repository (`apsych00/xchief-gold-rush`); ask the developer which branch is the campaign branch.

## 1. Create the VPS

At your provider, create a server with the Ubuntu 24.04 image and the size
above. Set a strong root password. Note its public IP address, e.g.
`188.6.6.6`. Then connect from your own computer:

```
ssh root@188.6.6.6
```

(all following commands run on the box, as root)

## 2. Install Docker (one line, official script)

```
curl -fsSL https://get.docker.com | sh
```

And Node, used to build the website and run admin scripts:

```
apt-get update && apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
```

## 3. Get the code

```
git clone https://github.com/apsych00/xchief-gold-rush.git goldrush
cd goldrush
git checkout <the campaign branch - ask the developer>
```

## 4. Configure it

```
cp .env.box.example .env
nano .env
```

`nano` is a text editor: type to edit, Ctrl+O then Enter to save, Ctrl+X to
exit. Fill in every line with no value (see the comment above each):

| Variable              | What to put                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `POSTGRES_PASSWORD`   | Invent one: run `openssl rand -hex 24` on the box and paste the result.                                                              |
| `DATABASE_URL`        | Same value as above, between the last `:` and `@db`. Example with password `abc123`: `postgresql://postgres:abc123@db:5432/postgres` |
| `SITE_ADDRESS`        | Your domain, e.g. `goldrush.xchief.com`.                                                                                             |
| `FINNHUB_TOKEN`       | Your Finnhub token (finnhub.io, free tier).                                                                                          |
| `PLAYER_TOKEN_SECRET` | Run `openssl rand -hex 32` and paste the result.                                                                                     |
| `ELASTIC_API_KEY`     | Your Elastic Mail API key.                                                                                                           |
| `OTP_SENDER`          | The verified sender address, e.g. `no-reply@goldrush.xchief.academy`.                                                                |

`PORT` can stay `8787`. Never share or commit the `.env` file.

## 5. Point the domain at the box

In Cloudflare, for your domain: add an **A record** named `goldrush` (or
whatever subdomain you chose in `SITE_ADDRESS`) with the box's IP address
(`188.6.6.6`), **Proxy status: Proxied (ON)**, and set SSL/TLS mode to
**Full**. Wait a minute for it to take effect. This is the only DNS change
needed; Caddy handles the https certificate from here.

## 6. Build the website and start everything

```
npm install
npm run build
docker compose up -d --build
```

The first run downloads everything (a few minutes). From now on, the box
starts all three parts by itself, after reboots included.

## 7. Check it works

Open `https://<your-domain>/health` in a browser. A short JSON response means
the game server is alive. Then open the homepage and play a round.

## 8. Create the kiosk screens

For each physical kiosk device, once:

```
npm run box:kiosk:new -- booth-1 https://<your-domain>
```

It prints a launch URL ending in `/?k=...` **exactly once**. Save it somewhere
safe and open it full-screen in Chrome kiosk mode on that device. Repeat with
`booth-2`, `booth-3`, `booth-4`, `booth-5`. Lost a secret? Revoke and reissue:

```
npm run box:kiosk:revoke -- booth-3
npm run box:kiosk:new -- booth-3 https://<your-domain>
```

Other admin scripts (see `scripts/README.md`):
`npm run box:kiosk:list`, `npm run box:coupons:export > coupons.csv`,
`npm run box:coupons:load -- codes.txt` (the file must be in the `goldrush`
folder), `npm run box:otp:peek someone@example.com` (dev only).

## 9. Take a snapshot

In your provider's control panel, take a **snapshot/backup image** of the
VPS now that everything works. Name it `goldrush-baseline`. Do this again
after any big change. It is the "undo button" for the whole box.

Done. The campaign runs itself from here.

---

## When something breaks

Stay calm and go in this order. All commands run in
`/root/goldrush` on the box (`ssh root@188.6.6.6` first).

**Read the logs** - what the game server saw, live (Ctrl+C to stop watching):

```
docker compose logs -f server
```

**See what is running.** All three should say `Up` (the db and server may say
`(healthy)`):

```
docker compose ps
```

**Restart the game server** - fixes most oddities, takes seconds, players just
reload the page (rounds in flight at that exact second are voided, which is
correct):

```
docker compose restart server
```

**Restart everything:**

```
docker compose down && docker compose up -d
```

**The website loads but the price never moves:** the feed sources are down or
`FINNHUB_TOKEN` is wrong. The game falls back to crypto-market gold prices on
its own; check `docker compose logs -f server` for feed messages.

**The browser shows a TLS/https error:** the domain is not pointing at this
box (step 5), or Caddy is still getting its certificate. `docker compose logs
caddy` shows what it is doing.

## Updating the website (frontend only)

The marketing lead changes the app, the change lands on the campaign branch,
and you want it live. Three commands, no downtime, no restart needed - the
site files are mounted live:

```
cd /root/goldrush
git pull
npm run build
```

Refresh a browser to see it (the game shows an "update available" banner).

## Updating the server or the database

```
cd /root/goldrush
git pull
npm run build
docker compose up -d --build
```

New database tables/migrations apply themselves on start, without losing any
data.

## Daily habits

- Once a day, open `https://<your-domain>/health` and play one round. That's it.
- Before real prizes go live, ask the developer to enable nightly database backups (planned, ticket S6).
