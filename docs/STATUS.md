# Gold Rush - condensed status

What's live, what's next. Product view. Updated as things land.

**Legend:** ✅ live · 🎨 owner handling · ⏳ later · 📋 owner action needed

Walk the dev build: web http://localhost:5173 · kiosk http://localhost:5173/kiosk (self-provisioning, no secret)

## Remaining

| Status | What | Notes |
|---|---|---|
| 🎨 | Play buttons look | You're redoing the Up/Down button styling |
| 📋 | Box deployment | Runbook (`docs/deploy-shared-box.md`) + private deploy repo are ready; needs SSH to the box, the Cloudflare Tunnel token, and the secrets listed at the end of the runbook |
| ⏳ | Claim email template | The code email is plain text for now (works, delivers the code); a designed template comes later |
| 📋 | Elastic Email unsubscribe | If the received code email still shows an unsubscribe footer, turn it off in the Elastic Email dashboard (it is account-level, not in our code) |
| ⏳ | Instagram BoxAPI edges | Verified working; two known edges to watch in the field - if a player follows 200+ accounts the follow may page out, and BoxAPI response shapes are handled defensively (confirm if they ever change) |

## Just landed (verified, on dev)

| What | Notes |
|---|---|
| Live chart even off-hours | When the real gold quote is flat, the server synthesizes gentle, realistic movement so the chart always has life; still fully server-decided |
| Instagram mission | Follow-verify via BoxAPI, working end to end (base URL, response parsing, web deep-link, Close button, check-flow race all fixed) |
| Claim page | The $100 code is now selectable with a Copy button; email input sized like the rest of the app |
| Share = image | A rendered badge/pass (real xChief logo) + native share sheet on phone, download + join link on desktop |
| Missions | Watch-to-earn YouTube (one row, 3 videos, 30s, 3-min unlock), Register-at-xChief (opens registration + 1h persistent timer), correct social icons, solo video row removed |
| YouTube embed | Hardened against the "not a robot" check (nocookie, origin, user-gesture) with an "open on YouTube" fallback |
| Kiosk | Open `/kiosk` link (self-provisions, no secret), self-heals a stale secret so it never bricks; iPad Air booth layout; "Play on web" QR on attract; Up/Down lock like web |
| English only | Persian text/layout removed from every screen |
| iPad Air layout | Kiosk and web screens fill the tablet to a thin edge; phone unchanged |
| Polish | Logo links home, animated glow background, ads clickable (goldrush UTM) with no white flash, tournament $3,000 broker-bonus prize, email prompts hide once signed in |
| Deployment | Go-live runbook (Cloudflare tunnel) + private deploy repo; legacy Supabase code and test artifacts cleaned out |

## Already live (core)

| What |
|---|
| The game - predict gold up/down in 5s, scoring, streaks |
| Web sign-in (email + code), leaderboard, tournaments, badges |
| Kiosk: play, win, gift-card-by-QR to the phone, idle reset, out-of-prizes screen |
| Live gold price feed, operator alerts, safe mode, rate limits, email masking |
