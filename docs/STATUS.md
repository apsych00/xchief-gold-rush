# Gold Rush - condensed status

What's live, what's cooking, what's next. Product view. Updated as things land.

**Legend:** ✅ live · 🔨 building now · 🕓 awaiting your sign-off · 📋 next up · ⏳ later · 🎨 owner handling

Walk the dev build: web http://localhost:5173 · kiosk http://localhost:5173/kiosk (self-provisioning, no secret)

## Cooking now (workers)

| Status | What | Notes |
|---|---|---|
| 🔨 | English everywhere | Removing the leftover Persian text/layout from every screen |
| 🔨 | iPad Air layout - web screens | Home, leaderboard, profile, missions, share sized for the 13" iPad; phone unchanged |
| 🔨 | iPad kiosk play screen | Refining the console body height and countdown fit on the booth iPad |
| 🎨 | Play buttons look | You're redoing the Up/Down button styling |

## Just landed (verified, on dev)

| Status | What | Notes |
|---|---|---|
| ✅ | Kiosk = open link | Booth opens `/kiosk` and self-binds, no secret; intro is now a clean English card |
| ✅ | iPad kiosk - first pass | Booth screens fill the tablet to a small edge |
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
