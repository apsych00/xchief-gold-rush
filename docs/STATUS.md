# Gold Rush - condensed status

What's live, what's cooking, what's next. Product view. Updated as things land.

**Legend:** ✅ live · 🔨 building now · 🕓 awaiting your sign-off · 📋 next up · ⏳ later · 🎨 owner handling

Walk the dev build: web http://localhost:5173 · kiosk http://localhost:5173/kiosk (self-provisioning, no secret)

## Cooking now (workers)

| Status | What | Notes |
|---|---|---|
| 🎨 | Play buttons look | You're redoing the Up/Down button styling |

## Waiting on you

| What | Notes |
|---|---|
| BoxAPI token | Put `BOXAPI_TOKEN` in `.env.box` (and swap the old Instagram OAuth vars for the K3 block) to turn the Instagram mission live; it shows "coming soon" until then |
| Box deploy | You're running it - runbook + deploy repo are ready |

## Just landed (verified, on dev)

| Status | What | Notes |
|---|---|---|
| ✅ | Share = image | A rendered badge/pass image + native share sheet (phone) or download + join link (desktop); no page, no copy-link; the "something went wrong" bug is gone |
| ✅ | Video missions | One row cycling 3 YouTube videos, watch 30s to earn, next unlocks after 3 min, "x of 3", white overlay note + Skip |
| ✅ | Instagram mission | Follow-verify via BoxAPI, server-decided; "coming soon" until the token is set |
| ✅ | Email prompts sync | The "add your email" prompts vanish the moment you verify; guests still see them |
| ✅ | Kiosk = open link | Booth opens `/kiosk` and self-binds, no secret; clean English intro; "Play on web" QR on the attract screen |
| ✅ | Kiosk gameplay + layout | Up/Down now lock like the web (Play Again to continue); console body shorter, countdown fits the iPad |
| ✅ | English everywhere | Persian text/layout removed from every screen |
| ✅ | iPad Air layout | Kiosk and web screens fill the 13" iPad; phone unchanged |
| ✅ | Ads clickable | Both banners open xchief.com with the goldrush UTM |
| ✅ | Share your score | Popup + public page; X / Telegram / copy-link with working icons and link |
| ✅ | Missions tab | No-skip YouTube missions; removed Google and Forex Peace Army reviews |
| ✅ | Register-at-xChief mission | Opens the registration page (goldrush UTM), no email modal, 1h timer that survives closing the app |
| ✅ | Logo + background | Logo links home; animated drifting glow background |
| ✅ | Ads | Only the two real banners looping; padding around them removed |
| ✅ | Deployment plan + repo | Go-live runbook (Cloudflare tunnel) + private deploy repo the box can pull from |
| ✅ | Cleanup | Removed dead Supabase code, unused packages, old test screenshots |

## Next up

| Status | What | Notes |
|---|---|---|
| 📋 | Kiosk welcome | Three intro cards ending on a QR to the web version (starts once the kiosk play refine lands) |

## Later

| Status | What | Notes |
|---|---|---|
| ⏳ | Go live | Deploy to goldrush.xchief.academy (separate deployment session) |
| ⏳ | Booth deploy | Stand up the kiosk at the venue right after we're live |
| ⏳ | Instagram mission | Follow-to-earn via the data API - last item, token in hand |

## Already live (core)

| Status | What |
|---|---|
| ✅ | The game - predict gold up/down in 5s, scoring, streaks |
| ✅ | Web sign-in (email + code), leaderboard, tournaments, badges |
| ✅ | Kiosk: play, win, gift-card-by-QR to the phone, idle reset, out-of-prizes screen |
| ✅ | Live gold price feed, operator alerts, safe mode, rate limits, email masking |
