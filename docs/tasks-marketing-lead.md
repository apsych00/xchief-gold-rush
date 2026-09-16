# Gold Rush - client tasks for the marketing lead

Date: 2026-09-16. Persian version: `tasks-marketing-lead.fa.md`.

Two parts. Part A is yours: screens, copy and the experience, delivered as designs plus a short note on how each should feel. Part B is ours (server, data, anti-fraud); it is listed so you know what the screens will be fed with and what is decided already.

Ground rules that apply to every task:

- Only the email identifies a web player. Remove the phone number and the name fields from every screen and modal that still has them.
- The kiosk has no email, no coins section, no profile and no leaderboard. A kiosk session belongs to the visitor in front of the machine; when it flushes, the device is as new.
- The server decides every score, rank, reward and coupon. The screens display; they never compute.
- New screens keep the existing look: same components, colours, type and spacing.

## Part A - screens and experience (marketing lead)

### A1. Leaderboard: ad zone

The bottom 40% of the leaderboard view is an ad zone for xChief banners. We will supply an array of banner assets; the zone shows one at a time, chosen at random, and rotates. Design the zone, the rotation (timing, transition) and the fallback when no asset has loaded. The list above keeps scrolling independently.

### A2. Leaderboard: paged list with a sticky "you" row

Everybody who plays is on the leaderboard, so the list is long.

- The first fold is live: the top 20 rows update as scores change.
- Scrolling down loads the next 20, then the next 20, and so on.
- If the player's own row is not yet on screen, a row for them is pinned to the bottom of the view, always visible, with their rank number next to it.
- When the scroll reaches the place where their row belongs, the pinned row becomes an ordinary row in the list. Scroll back above it and it pins again.

Design the pinned row, the moment it snaps into place, the loading of each page, and the empty and error states. It must be buttery smooth: no jumps, no flicker, no layout shift when a page loads or a rank changes.

### A3. Leaderboard: tournaments, prizes, badge legend

The leaderboard is a series of tournaments, not one long contest. The first runs 16 to 21 September, the next 21 to 24 September; more will follow and each has its own prize for first place plus a bonus on the xChief broker at signup.

Design:

- The tournament header: title, date range, days or hours left, and the prize as an image with a title.
- A way to see past and upcoming tournaments (a strip, tabs or a switcher) and their winners once closed.
- A badge legend: every row carries a tier badge next to the name; the legend explains each badge. Put it where a player can find it from the leaderboard and from the profile.

Tournament dates, prizes and count are data we set; the design should not assume a fixed number.

### A4. Account and profile screen

A new screen for the player.

- Not logged in: say so plainly, offer login with email, and show the bonus they receive on login (this is the coins reward tied to email verification).
- Logged in: masked email, current rank, total coins, position in the current tournament, and as much of their activity as we can show (rounds played, best streak, rewards claimed, tournaments entered).
- Sign out.

### A5. First-visit tour (web)

An introduction shown once per device on first visit. It covers what this is, how a round works, what the coins are for, how the leaderboard and tournaments work, what the prizes are and what the badges mean. Design the flow (modal steps or a guided tour over the real screens), the copy, and where a player can reopen it.

### A6. First-visit intro (kiosk)

A refreshed kiosk intro, different content from the web tour: what this is, what it is about, what it is trying to do, the rules, the prizes and what the badges mean. It sits between the attract screen and play, is quick to skip, and must not slow the queue at the booth.

### A7. Coins section: rewards rework

The coins (rewards) section changes as follows.

- Remove the "review on Google" item and the "Forex Peace Army" item.
- Add a video reward: a set of short xChief YouTube videos (under one minute each). The player watches one and is rewarded when 90% or more of it has played. Design the player, the progress cue, the reward moment, and the state when all videos are watched.
- Trustpilot review, YouTube subscribe and Telegram join become redirect rewards: tapping opens the destination, a 5-second timer runs in the app, and the reward is released when the player returns. Design the timer state and the return moment.
- Instagram follow is verified against Instagram; design the connect step, the checking state and the failure state.
- Email verification is itself a reward: once verified the player is logged in and rewarded.
- Every claimed reward stays visibly claimed on later visits; there is no second claim.

The coins section does not exist on the kiosk.

### A8. Deliverable format

For each task: the screen designs, the copy, and a short note (a few lines) on how you suggest it should behave. Reuse the existing components and styles; if something new is genuinely needed, say why.

## Part B - our side (server, data, anti-fraud), in priority order

| # | Card | Why this order |
|---|---|---|
| B1 | Tournaments as data: a table (or config file) with id, title, start, end, prize image, prize title, broker bonus text; adjustable without code changes; the leaderboard API takes a tournament and defaults to the current one. | Everything on the leaderboard hangs off it; dates start 16 September. |
| B2 | Leaderboard API: paged (20 per page), the player's own rank and row in every response, live top-20 push over the socket, masked emails computed server-side. | A2 cannot be built without it. |
| B3 | Badge tiers: the rule that assigns a tier, stored with the rank, and a legend endpoint the client renders. | A3 legend. |
| B4 | Remove name and phone from the lead capture API and storage; email only. | Ground rule; small. |
| B5 | Per-device identity for anonymous players: a device id issued by the server, stored on the device, tied to rewards so a reward is claimed once per device or per email. | Every reward rule below depends on it; this is the fraud surface. |
| B6 | Reward: video watched. Server-issued video list; client reports progress; the server releases the reward at 90% once per device. | A7. |
| B7 | Reward: redirect and return (Trustpilot, YouTube, Telegram). The server starts the 5-second window, the client reports the return, the reward is released once per device. | A7. Deliberately lenient; hardened later. |
| B8 | Reward: Instagram follow verified through the Instagram API; one Instagram account per device or email. | A7. Needs an app and token on the Instagram side. |
| B9 | Reward: email verified. Already logs the player in (done); add the reward and the claimed record. | A4, A7. |
| B10 | Tour seen flag per device (web) and per kiosk boot (kiosk) so the intro shows once. | A5, A6. |
| B11 | Ad banner list served to the client (static list of assets), random pick client-side. | A1. |
| B12 | Curate the YouTube list: pick the most relevant xChief videos under one minute. | A7 content. |
| B13 | Hardening pass on rewards and anonymous identity: rate limits, replay checks, one claim per device and per email enforced in the database, audit of claims. | After B5 to B9 work end to end, same layering as before. |
| B14 | Five-win streak tests, kiosk and web: coupon issued on the fifth win, WIN modal with the code and the Claim cycle, exhausted pool keeps the streak, web shows streak and multiplier from the server. Written blind. | Q1 scenario the booth depends on. |
| B15 | MT5 through Docker: an MT5 terminal plus tick bridge container as the alternative to MetaApi, selected by `MT5_BRIDGE_WS`. | Independence from MetaApi's token and interval limits. |
| B16 | E2E regression after the profile screen merge: three web and kiosk tests time out; diagnose from the trace and fix. | Every merge gates on the E2E. |
| C2b | Kiosk idle rework: countdown after 20 s of no activity at all, any pointer or key activity cancels and restarts it, reset at zero. Today it shows at 30 s idle and flushes at 60 s. | Product rule from the booth walkthrough. |

Order of work on our side: B16 first (it gates every merge), then B14, B15 and C2b in parallel with C5 to C7; then B1, B2, B4 (the leaderboard and the ground rule), then B5, then B6 to B9, then B3, B10, B11, B12, then B13.
