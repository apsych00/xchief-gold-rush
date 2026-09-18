# Gold Rush - condensed status

What's live, what's cooking, what's next. Product view. Updated as things land.

**Legend:** ✅ live · 🔨 building now · 🕓 awaiting your sign-off · 📋 next up · ⏳ later · 🎨 owner handling

Walk the dev build: web http://localhost:5173 · kiosk http://localhost:5173/?k=dev-kiosk-secret-0001

## Awaiting your sign-off

| Status | What | Notes |
|---|---|---|
| 🕓 | iPad Air kiosk layout | Booth screens now fill the 13" iPad; phone unchanged. Please eyeball and approve |
| 🎨 | Play buttons look | You're redoing the Up/Down button styling |

## Just landed (verified, on dev)

| Status | What | Notes |
|---|---|---|
| ✅ | Share your score | Popup + public share page; X / Telegram / copy-link with working icons and link |
| ✅ | Missions tab | Coins tab is now Missions - no-skip YouTube missions |
| ✅ | Register-at-xChief mission | Opens the registration page (goldrush UTM), no email modal, with a 1h timer that survives closing the app |
| ✅ | Open kiosk link | `/kiosk` starts a booth session without the secret in the URL |
| ✅ | Logo + background | Logo links home; animated drifting glow background instead of pitch black |
| ✅ | Ads | Only the two real banners, looping; dark padding around them removed |
| ✅ | Missions trim | Removed Google and Forex Peace Army reviews |
| ✅ | Deployment plan + repo | Go-live runbook (Cloudflare tunnel) + private deploy repo the box can pull from |
| ✅ | Cleanup | Removed dead Supabase code, unused packages, and old test screenshots |

## Next up

| Status | What | Notes |
|---|---|---|
| 📋 | English everywhere | Remove the leftover Persian text (app already shows English only; this deletes the dead copy) |
| 📋 | Kiosk welcome | Three intro cards ending on a QR to the web version |
| 📋 | iPad Air layout - web | The rest of the screens, after the kiosk pass is signed off |

## Later

| Status | What | Notes |
|---|---|---|
| ⏳ | Go live | Deploy to goldrush.xchief.academy |
| ⏳ | Booth deploy | Stand up the kiosk at the venue right after we're live |
| ⏳ | Instagram mission | Follow-to-earn via the data API - last item, token in hand |

## Already live (core)

| Status | What |
|---|---|
| ✅ | The game - predict gold up/down in 5s, scoring, streaks |
| ✅ | Web sign-in (email + code), leaderboard, tournaments, badges |
| ✅ | Kiosk: play, win, gift-card-by-QR to the phone, idle reset, out-of-prizes screen |
| ✅ | Live gold price feed, operator alerts, safe mode, rate limits, email masking |
