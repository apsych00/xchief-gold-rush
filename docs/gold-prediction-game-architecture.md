# Gold prediction game: architecture decisions

This is the foundation we landed on for the marketing campaign game. It's not a build spec. It's the set of decisions that should shape whatever gets built, so nobody re-litigates them halfway through.

## What we're building

A game where a player predicts whether the gold price will go up or down over the next 5 seconds. Correct predictions score points, which accumulate.

Two modes run on the same core game logic but behave differently:

- **Web**: players enter an email, get authenticated, and their score feeds a persistent leaderboard (top 10) over a 1-month campaign. Top 3 at the end get bonuses and gifts.
- **Kiosk**: runs at an exhibition, no email. Five wins in a row triggers a streak reward, a $100 bonus code. The code is claimed once and gone. The next person starts fresh. Nothing about a kiosk player's identity needs to persist beyond that streak.

## Platform choices

We're keeping the pieces already in place and adding one:

- **Vercel** stays as the frontend host.
- **Fly.io relay** stays as the gold price feed. It does one job, feeding live prices, and nothing about that needs to change.
- **Supabase** is the new piece: Postgres, auth, auto-generated API, and edge functions, all in one place.

The reasoning: we don't want to build and operate a custom backend under time pressure. Supabase gets us there fastest without giving up security, because the security model is declarative (row-level security policies on tables) rather than something we have to hand-write and audit ourselves.

Most of the app talks to Supabase directly from the client, no custom API route in between. Supabase generates a REST and GraphQL API from the Postgres schema. Reads and writes go through that, restricted by row-level security policies defined on each table. A player can read the leaderboard and their own score; they can't write to either directly.

Two things don't fit that pattern and need actual server-side code: resolving a round's outcome, and claiming a coupon. Both involve a decision that can't be left to the client. Both are small functions Supabase hosts and runs for us, not a service we stand up and maintain.

## Server decides, not the client

This is the core security rule the rest of the design serves: **the client never reports its own result.**

A player submits a direction guess tied to a round the server issued. The server independently pulls the price from the Fly.io relay at the start of the round and again when it resolves, and decides win or loss itself. There's no path where a client can just say "I won."

The same principle applies to coupon codes. A kiosk doesn't tell the server "give me a code." It tells the server it hit a 5-win streak, and the server checks that claim against what it already tracked server-side before handing one out.

## Auth and OTP

Web players authenticate by email using Supabase's built-in one-time password flow. Supabase handles sending, expiry, and rate-limiting; we don't write that logic ourselves. It sends through Elastic Mail, which is already set up, wired in as Supabase's outgoing SMTP provider.

Kiosk mode doesn't use this system at all. Kiosks aren't users with emails, so we're not forcing them through the player auth path. They get a separate, lighter credential, described below.

## Coupon codes

Codes are tracked in a table with a status (available or claimed). Claiming one is an atomic operation: the server picks one available row and marks it claimed in the same step, so two near-simultaneous claims can't both walk away with the same code. This matters more at a kiosk than it would online, since a booth can get bursts of activity.

## Kiosk sessions

Each physical kiosk gets its own secret token, generated once during setup. The server stores only a hash of it, the same way a password would be stored, never the raw value.

That secret is what turns "kiosk mode" on for a device, and it's what ties a coupon claim to a specific machine. A request without a valid, active secret can't claim a coupon, full stop.

Decisions on how this works day to day:

- **Handoff.** The secret is baked into that kiosk's fixed launch URL rather than stored in the browser's local storage, since Chrome kiosk profiles can get reset and local storage doesn't reliably survive that. The operator sets the URL once and doesn't touch it again.
- **Validation.** Every kiosk action, starting a round or claiming a coupon, checks the secret against the stored hash and the kiosk's active status before doing anything.
- **Rotation.** Swapping a kiosk's key is a single update to its stored hash, plus updating that one machine's URL. Other kiosks are unaffected.
- **Revocation.** If a kiosk needs to be shut off, its status flips to revoked. Its old secret stops working immediately, everything else keeps running.

This is deliberately lightweight. With a small, physically controlled set of kiosks, a bearer secret checked against a stored hash is enough. We're not adding OAuth or token-refresh machinery for this.

## What's still open

This document covers the decisions, not the implementation. Still to work out: the actual Postgres schema, the row-level security policies, the two server-side functions (round resolution and coupon claim), and the kiosk table and its validation function.
