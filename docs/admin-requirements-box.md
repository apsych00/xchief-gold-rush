# xChief Gold Rush - what we need from administration (box deployment)

The game runs on one Linux server plus a handful of accounts the organization owns. This is the complete list. Nothing on it needs coding; each row says what to create, what setting to make, and what to hand to the developer. Send anything marked **secret** through a password manager or an encrypted message - never plain email or chat.

Hands-on time: about one hour, plus DNS propagation.

---

## 1. The server

| Item | Requirement |
|---|---|
| Provider | Any reputable VPS provider with snapshots: Hetzner, DigitalOcean, Vultr, OVH, Linode |
| Size | **4 vCPU, 8 GB RAM, 80 GB SSD** (this handles 4x the projected traffic with room to spare; do not go below 2 vCPU / 4 GB) |
| OS | **Ubuntu 24.04 LTS**, fresh, 64-bit |
| Region | Frankfurt or Amsterdam (nearest to the price feed and to Cloudflare's European edge; Dubai visitors are served through Cloudflare) |
| Snapshots | Enabled (automatic weekly if the provider offers it) |
| Access | **Root SSH with the developer's public key** (they will send it); no password login |
| Network | A public IPv4 address (IPv6 optional). No firewall rules needed at the provider level beyond default; the box configures its own |

Hand over: the IP address and confirmation the SSH key is installed.

## 2. Cloudflare (DNS and edge protection)

| Item | Requirement |
|---|---|
| Account and zone | The campaign's domain (e.g. `goldrush.xchief.com`, or whichever hostname marketing chooses) must be in a Cloudflare zone. Free plan is enough |
| DNS record | `A` record for that hostname -> the server's IPv4, **proxy status: Proxied (orange cloud)** |
| SSL/TLS mode | **Full (strict)** (Overview -> SSL/TLS) |
| WebSockets | On (default on all plans) |
| Bot Fight Mode | On (Security -> Bots) |
| Access to the operator pages | Either add the developer as a **member of the zone** (Administrator or DNS + Access roles), or create the two items below yourself when the developer sends the details: a Cloudflare Access application protecting `/logs` and `/ops`, and one rate-limiting rule on `/ws` and `/api/*` |

Hand over: the hostname, and either member access for the developer or confirmation of the record and settings.

## 3. Email (Elastic Mail)

Already provisioned; the sending subdomain `goldrush.xchief.academy` is verified (SPF, DKIM, DMARC) and the branded template `gold_rush_otp` exists. Three things remain:

| Item | Requirement |
|---|---|
| API key | An Elastic Mail **API key with sending permission** for production - **secret** |
| Plan | A sending plan that covers up to **2,000 emails a day (~60,000 a month)**; confirm the current plan does |
| Sender | Confirm the from-address: `no-reply@goldrush.xchief.academy` |

Hand over: the API key (secret) and confirmation of the plan and sender.

## 4. Price feed (Finnhub)

The existing key works for the real-time XAU/USD stream. Nothing to do. If a new key is ever issued, hand it over as a **secret**; only one connection per key is allowed, and the server holds exactly one.

## 5. MT5 price feed (optional upgrade, strongly recommended for a livelier chart)

To stream the broker's own gold ticks into the game we need a read-only view of an MT5 account and a bridge service.

| Item | Requirement |
|---|---|
| MT5 account | An **xChief trading account** (a demo or a small live account is fine) with an **investor (read-only) password** - it cannot trade, only watch prices |
| Details to hand over (**secret**) | Account login number, the **investor** password (never the master password), the MT5 **server name** exactly as shown in the terminal (e.g. `xChief-Live` / `xChief-Demo`), and the exact gold symbol on that server (`XAUUSD`, `XAUUSD.`, `GOLD`, ...) |
| Bridge service | A **MetaApi.cloud** account (metaapi.cloud): create it, add the MT5 account above under "Trading accounts" using the investor password, and generate an **API token** (**secret**). Cost is per connected account, on the order of tens of dollars a month; confirm on their pricing page. This is the fastest route (about an hour). The alternative - running an MT5 terminal on a Windows VM with our own bridge - is a day's work and one more machine to keep alive; only if MetaApi is not acceptable |

Hand over: the MetaApi token (secret), the MetaApi account id it assigns, the symbol name. The game server takes these as three settings; nothing else changes.

## 6. Business inputs

| Item | Requirement |
|---|---|
| Coupon codes | The list of real **$100 codes**, one per line, as many as the campaign should award; each is handed out once |
| Alerts | A phone or email to receive "price feed silent" / "server restarted" alerts (a free ntfy.sh topic on a phone works; or a Slack/Discord webhook URL) |
| Campaign dates | Start and end date/time, in Dubai time, so the leaderboard can be frozen at the end |
| Domain name | The final public hostname, decided with marketing |

## 7. What administration does NOT need to do

- No GitHub, Vercel, Supabase or Fly.io accounts.
- No installing anything on the server: the developer installs Docker and everything runs in containers.
- No firewall configuration at the provider: the box locks itself down (only ports 80/443 from Cloudflare and SSH).
- No ongoing maintenance during the month beyond keeping the accounts paid.

## 8. Checklist - deliver to the developer

**Secret (encrypted channel):**
- Elastic Mail API key
- MT5 login number, investor password, server name (if going ahead with MT5)
- MetaApi token and account id (if going ahead with MT5)
- Alert webhook URL (if using Slack/Discord rather than ntfy)

**Not secret:**
- Server IP + confirmation the SSH key is installed
- Campaign hostname, and either Cloudflare member access or confirmation of the DNS record + settings
- Elastic Mail plan confirmation and sender address
- MT5 gold symbol name
- Coupon code list
- Campaign start/end
- Alert destination (phone app topic name)

## 9. Monthly cost, box topology

| Item | Monthly |
|---|---|
| VPS 4 vCPU / 8 GB with snapshots | ~$25-40 |
| Cloudflare free plan | $0 |
| Elastic Mail sending plan | ~$29-39 |
| Finnhub | $0 |
| MetaApi (optional) | ~$10-40 (confirm) |
| **Total** | **~$55-120**, fixed - no usage-based surprises |
