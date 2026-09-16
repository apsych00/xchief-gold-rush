# Capacity and billing projection

For whoever charges the accounts. Says how much load to expect, which plan each service needs, when to buy it, and how much headroom to fund if the booth gets crowded. Prices are list prices as of September 2026; confirm on each pricing page at purchase time.

## The projection, doubled

Stated projection: 50 players at once, up to 1,000 a day. Planned for **double**: **100 concurrent, 2,000 a day**, for one month (30 days). A "crowded" case at 4x (200 concurrent, 4,000 a day) is shown so the headroom number is concrete.

Assumptions behind the traffic numbers: a player plays ~25 five-second rounds per visit and claims ~3 tasks; the app is ~3 MB on first load; each web player triggers one login email.

| Metric | Stated (1x) | Planned (2x) | Crowded (4x) |
|---|---|---|---|
| Players / day | 1,000 | 2,000 | 4,000 |
| Players / month | 30,000 | 60,000 | 120,000 |
| Rounds / day | 25,000 | 50,000 | 100,000 |
| Function calls / month (rounds + tasks) | ~830k | ~1.7M | ~3.3M |
| Peak round calls / second | ~10 | ~20 | ~40 |
| Concurrent held-open rounds (5 s each) | ~50 | ~100 | ~200 |
| Rounds stored / month (audit rows, ~250 B each) | 750k (~190 MB) | 1.5M (~380 MB) | 3M (~750 MB) |
| Login emails / day | 1,000 | 2,000 | 4,000 |
| Site bandwidth / month | ~90 GB | ~180 GB | ~360 GB |
| Live-price WebSocket connections at peak | 50 | 100 | 200 |

## What each service needs at the planned (2x) load, and when to buy

| Service | Plan to buy | Monthly cost | Buy when | Why this plan |
|---|---|---|---|---|
| **Supabase** | Pro | $25 + usage | **Before launch day** | Free tier caps function calls at 500k/month (we need ~1.7M) and pauses idle projects. Pro includes 2M calls, 8 GB database, 250 GB egress, daily backups, no pausing. |
| **Vercel** | Pro (1 seat) | $20 | **Before launch day** | Hobby is non-commercial and capped at 100 GB bandwidth (we need ~180 GB). Pro includes 1 TB. |
| **Fly.io** | Pay-as-you-go, card on file | ~$3-5 | **Before launch day** | One always-on `shared-cpu-1x` machine; a card is required to run at all. |
| **Elastic Mail** | A sending plan covering **60,000 emails/month** | ~$29-39 | **Before launch day** | Free is ~100/day; we send up to 2,000/day. |
| **Finnhub** | Free | $0 | - | One shared connection; unaffected by player count. |
| **GitHub** | Free | $0 | - | Backup only. |

**Planned monthly total: about $80-90.** Everything is bought once, before day one. Nothing needs to be bought mid-campaign at planned load.

Note: the organization asked that paid plans be requested only after the application has been tested for a day. Do that test on the free tiers on a quiet day, then upgrade all four before the expo opens. Free tiers do not degrade gracefully - they stop.

## Headroom: what "crowded" (4x) costs, and how to fund it

Only two services scale with load; both bill overage automatically instead of cutting off, provided the caps below are set correctly.

| Service | Planned (2x) | Crowded (4x) | Overage mechanics |
|---|---|---|---|
| **Supabase** | inside Pro's 2M calls, 8 GB DB | ~3.3M calls, ~750 MB DB: about **+$3-5** overage (calls are ~$2 per extra million) | **Turn OFF the Spend Cap** (Organization -> Billing). It is ON by default and throttles at the quota instead of charging. |
| **Vercel** | ~180 GB of 1 TB | ~360 GB, still inside 1 TB: **$0** | Overage only above 1 TB, ~$0.15/GB. Leave the optional spend limit unset or set it to $50. |
| **Fly.io** | one machine | one machine still handles 200 sockets: **$0** extra | Usage billing; only rises if we add machines, which we will not. |
| **Elastic Mail** | 60k/month plan | 120k/month: **next plan tier, ~+$30**, or the plan's per-email overage | Not automatic on all plans; check whether the chosen plan allows overage or needs a tier bump. |

**Headroom to fund for the whole campaign at 4x: about $50 on top of the base plans.** A $150 budget for the month covers the planned load with the crowded case fully absorbed.

## The two settings that decide whether a spike is billed or breaks the game

1. Supabase: **Spend Cap OFF.** With it on, a crowded hour throttles the round function and the booth stalls.
2. Vercel: **no spend limit, or one above $50.** A hard limit at $0 would take the site offline at the bandwidth cap.

## Checklist for the person paying

- [ ] Supabase Pro on the production project, Spend Cap off
- [ ] Vercel Pro, one seat, spend limit unset or above $50
- [ ] Fly.io card on file
- [ ] Elastic Mail plan covering 60k emails/month
- [ ] Budget approved: ~$90/month base, $150 with headroom
