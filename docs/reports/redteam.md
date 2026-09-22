# Red team: the box game server

Twenty-three attacks against a running box stack - the WebSocket game server, its Postgres, and
the unauthenticated HTTP endpoints - run with `demo/redteam.mjs`. Every OBSERVED line in this
document came back from a live server. Nothing here is reasoned about statically and then
written up as if it had been tried.

- **Target:** `server/index.js` on `ws://localhost:8787/ws` + `http://localhost:8787`, against a
  fresh `db/schema.sql` + `db/seed.sql` database (`bash db/run-tests-demo.sh --keep`, port 55447).
- **Attacker's tools:** raw `ws` sockets, `fetch`, and `psql` as the `anon` role. No app code.
- **Date:** 2026-09-16. **Model:** `claude-opus-5[1m]` (Opus 5, 1M context), confirmed from the
  model identity in this session rather than a UI badge.
- **Supersedes** `docs/reports/redteam-supabase-2026-09-15.md`, which attacked the Supabase
  backend this box replaced. That document is kept for its history; none of its findings apply to
  the current code.
- Nothing was committed. `.env` was never opened.

## Bad news first

**Two attacks succeeded.**

- **D1 (High) - `kiosk_reset` does not cancel the round it is standing on.** Reset a kiosk
  session while a round is in flight and the verdict lands 5 seconds later on the _new_ session:
  the stake is re-based onto a fresh 1000-coin pot, and the booth is dragged back out of attract
  mode into a stranger's result. This is a booth-floor bug before it is a cheat.
- **D2 (Medium) - nothing rate limits a socket.** 20 000 `get_me` frames down one connection were
  all accepted and all answered: 20 000 database round-trips, sustained at 399/s for 50 seconds,
  with no throttle, no cut-off and no disconnect. The server survived this burst. Nothing in the
  code stops a bigger or a sustained one. Ticket S2 is queued and not started.

**Four more are open doors rather than broken locks** - D3 to D6 below. The biggest of them is
that `request_otp` will send mail to any address, as fast as you can ask, for ever.

**The invariant itself held, under everything.** A client cannot declare a verdict, cannot set a
stake or a reward, cannot reach the price, cannot hold two rounds at once, cannot dodge a loss by
disconnecting, cannot forge or steal a player token, cannot claim a task or a refill twice, cannot
verify an email without its code, and cannot get a coupon issued twice - including in a genuine
two-booth race for the last code in the pool. The `anon` Postgres role cannot call a single
service-role function. The DEV cheat hook is not in a production build.

## The attacks

| #   | Attack                                                      | Verdict      | One line                                                                      |
| --- | ----------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------- |
| A1  | Client declares its own win, coins and coupon               | **HELD**     | Unknown frame types fall through `default: break`; nothing moved.             |
| A2  | Client attaches its own stake, price, multiplier and reward | **HELD**     | `stake=100`, `mult=1.5`, `reward=300` - all from SQL, all ignoring the frame. |
| A3  | Two rounds at once on one identity                          | **HELD**     | Second play refused `round_in_flight` by a partial unique index.              |
| A4  | Two sockets on one token race a play                        | **HELD**     | Same player id; one `round_opened`, one `round_in_flight`.                    |
| A5  | Dodge a loss: disconnect mid-round, then replay the play    | **HELD**     | Round settled anyway; replay refused; missed verdict delivered once.          |
| A6  | Forged, expired and revoked player tokens (8 variants)      | **HELD**     | Every one became a fresh anonymous player, never the victim.                  |
| A7  | Kiosk secret: guessing, length floor, reuse after revoke    | PARTIAL      | No guess authenticated; revoke enforced. See D7 (closed), D9, D10.            |
| A8  | Web frames on a kiosk socket, kiosk frames on a web socket  | PARTIAL      | All player frames gated. `leaderboard` is not. See D8.                        |
| A9  | Claim the same task twice, fast                             | **HELD**     | One claim row, one reward; the loser got `already_claimed`.                   |
| A10 | Take the one-time free refill twice                         | **HELD**     | One grant of +300; every later call `already_refilled`.                       |
| A11 | OTP: unlimited requests, brute-force a code                 | PARTIAL      | The code held. The request endpoint did not. See D3.                          |
| A12 | Take over someone else's verified email                     | **HELD**     | Eight ways in, all `expired_code`. Only the mailed code works.                |
| A13 | `leaderboard` / `/status` leaking raw emails or ids         | PARTIAL      | No raw address, no uuid. `/status` is open to anyone. See D6.                 |
| A14 | Force a flat by timing the play                             | **HELD**     | A flat pays zero. There is no profit in timing one.                           |
| A15 | Kiosk at a 4-win streak reconnecting to keep or inflate it  | PARTIAL      | Cannot be inflated. The secret is in the URL. See D5 (closed).                |
| A16 | Dodge a kiosk loss by resetting the session mid-round       | **LOOPHOLE** | **D1.**                                                                       |
| A17 | Influence the start or end price                            | **HELD**     | Both prices came off the server's own feed, to three decimals.                |
| A18 | Two kiosks hit five wins at once with one coupon left       | **HELD**     | Real two-winner race: one code, one `coupons_exhausted`.                      |
| A19 | Message flood from one socket                               | **LOOPHOLE** | **D2.**                                                                       |
| A20 | Oversized and malformed frames                              | PARTIAL      | Parsing held. A 64 MB frame was accepted. See D4.                             |
| A21 | Service-only SQL as the `anon` role                         | **HELD**     | 16 of 16 denied; `leaderboard()` allowed, as designed.                        |
| A22 | The unauthenticated HTTP surface (`/api/lead`)              | PARTIAL      | Validation held. A 64 MB body was accepted. See D4.                           |
| A23 | The DEV hook `window.__xchief.inject` in a production build | **HELD**     | Zero matches across three bundles.                                            |

`HELD` 14 · `PARTIAL` 7 · `LOOPHOLE` 2.

---

## Defects

### D1 - `kiosk_reset` does not cancel the round it is standing on - **High**

**Reproduce.** `node demo/redteam.mjs --only A16`, which does this over a raw kiosk socket:

1. Put a kiosk mid-session with a 200-coin pot (`update public.kiosks set
session_state='playing', session_coins=200, streak=0, last_round_at=now() where id = ...`).
2. `{"type":"auth","kiosk":"<secret>"}`, then `{"type":"play","dir":"up","lever":1}`.
3. 500 ms later, well inside the 5-second round, `{"type":"kiosk_reset"}`.
4. Wait for the verdict that arrives anyway.

By hand at the booth the same thing is: start a round, then press **Claim**, press **Done**, or
walk away into the idle flush before it resolves.

Observed, verbatim:

```
pot at open: 200 (playing); round e28d75a6-31a6-47e1-8f70-f785c0766093
kiosk_reset reply: coins=1000 state=idle
verdict that still arrived: lose delta=-100 coins=900 state=playing
pot after: 900 state=playing streak=0
pot had the reset not landed: 100 - actual 900, so the stake at risk was re-based onto
the fresh 1000-coin pot (800 coins out of nothing)
the reset put the machine in 'idle' (attract) and the late verdict put it back in 'playing'
```

**Impact.** Two things, and the second is worse than the first.

1. _The stake comes back._ A losing round that should have left 100 coins left 900, because
   `settle_kiosk_round()` applied the delta to whatever `session_coins` happened to be at settle
   time - and by then `reset_kiosk_session()` had put 1000 there. The same works for a win: 300
   honest coins became 1100. A visitor holding the kiosk URL never has to go broke.
2. _The booth un-resets itself._ `settle_kiosk_round()` writes `session_state='playing'`
   unconditionally. So a booth that just went to attract - because someone pressed **Claim**, or
   **Done**, or walked away and the idle flush fired - is pulled back into the play screen up to 5
   seconds later, showing the previous visitor's verdict and coins to whoever is standing there.
   `Claim` at a five-win modal with a round still open is the realistic trigger; nobody has to be
   cheating for this to happen.

**Smallest fix.** In `reset_kiosk_session()` (and `start_kiosk_session()`), void any round still
open for that kiosk in the same statement, so the late settle finds nothing to settle:

```sql
update public.rounds set status = 'settled', outcome = 'void', end_at = now()
where kiosk_id = p_kiosk and status = 'open';
```

`settle_kiosk_round()` already raises `round_not_open` for a settled round, and `server/rounds.js`
already logs and drops a failed settle without touching the socket - so one added statement closes
both halves of this. Same treatment is worth considering for `open_round`'s player path, though
there is no player-side reset to trigger it.

**File.** `db/schema.sql`, `public.reset_kiosk_session` (and `public.start_kiosk_session`).

---

### D2 - No rate limit of any kind on a socket - **Medium**

**Reproduce.** `node demo/redteam.mjs --only A19`.

```
20000 frames queued in 819 ms; the socket was never closed or throttled by the server
me replies received back: 20000/20000 over the next 50120 ms (399 db round-trips/s sustained)
server still healthy afterwards: true (db true)
a bystander connecting during the flood: welcome in 31 ms, play -> round_opened
```

**Impact.** One anonymous connection - no token needed, `{"type":"auth"}` is enough - can queue
unbounded work for the database. This run was survivable and a bystander stayed responsive at 31
ms, which is the honest result and worth saying. But the number that matters is that the server
_never refused anything_: there is no cut-off to hit. `play` is cheaper to abuse still, because
`open_round`'s own 400-rounds-per-hour limit is per player and a client can mint unlimited
anonymous players (`auth` with no token creates a row every time).

**Smallest fix.** A per-socket token bucket in `server/index.js`'s `ws.on('message')`, before
`handleFrame`: N frames per second, terminate past a burst ceiling. Roughly ten lines, no schema
change. This is exactly ticket **S2**, which is queued and unstarted.

**File.** `server/index.js`.

---

### D3 - `request_otp` is unlimited, and superseded codes stay valid - **Medium**

**Reproduce.** `node demo/redteam.mjs --only A11`.

```
40 request_otp accepted in 1238 ms (32.3/s), zero refusals; otp_codes rows for the address: 40
wrong-code guesses: invalid_code x4, too_many_attempts, invalid_code, invalid_code
guesses still accepted after that lockout, without requesting anything more: 120
request_otp aimed at victim-who-never-played@example.com: 10/10 accepted
```

**Impact.** Three separate things, in order of how much they will cost:

1. **Mail bombing on the campaign's own sender.** Any anonymous player can ask the server to mail a
   login code to any address, at 32 requests a second, for ever. In production that is 32 real
   Elastic Mail sends a second to someone who never asked. The cost is not the mail - it is the
   sender reputation the whole campaign's login depends on.
2. **The 5-try lockout is per code, not per email.** `verify_otp_code()` picks the newest _unused_
   code. Burning one just steps down to the next one in the pile, because `request_otp_code()`
   never invalidates the codes it supersedes. Measured: 120 further guesses accepted after a
   `too_many_attempts`, with no new request. The guess budget is `5 x codes requested`, and codes
   requested is unbounded.
3. **Unbounded row growth** in `public.otp_codes`, keyed on nothing but time.

An 8-digit code over 10^8 still makes an actual takeover impractical - roughly 1.4 x 10^7 requests
for even odds, days of sustained hammering per address. The takeover is not the risk here. The mail
is.

**Smallest fix.** Two lines of SQL and one counter:

```sql
-- in request_otp_code, before inserting the new code
update public.otp_codes set used_at = now()
where email = p_email and used_at is null;
```

plus a per-email and per-connection rate limit on `request_otp` in `server/index.js` (part of
ticket **S2**; the retention half belongs to **S11**).

**Files.** `db/schema.sql` (`public.request_otp_code`), `server/index.js`.

---

### D4 - No size cap on a WebSocket frame or an HTTP body - **Medium**

**Reproduce.** `node demo/redteam.mjs --only A20,A22`.

```
64 MB single frame -> me after 687 ms - ACCEPTED: buffered, JSON.parsed and acted on
64 MB body to POST /api/lead -> 204 in 446 ms
```

**Impact.** `new WebSocketServer({ noServer: true })` takes the `ws` default `maxPayload` of 100
MB, and `readJsonBody()` concatenates an HTTP body with no limit at all. Every open socket and
every unauthenticated POST is therefore a 100 MB (or larger) memory allocation on request. Fifty
concurrent sockets is the design target; fifty concurrent 100 MB frames is not survivable on a box.
Neither endpoint needs more than a few kilobytes.

**Smallest fix.**

```js
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
```

and a byte counter in `readJsonBody()` that destroys the request past ~64 kB.

**File.** `server/index.js`.

---

### D5 - The kiosk bearer secret is in the launch URL - **Medium** (tracked: S3)

**Closed by ticket S3.** The `?k=<secret>` launch URL this finding describes is removed entirely;
`/kiosk` (ticket K1) plus a secret held only in that device's local storage is the sole way to
authenticate a kiosk client now. Nothing below is rewritten - it is the finding as recorded.

**Reproduce.** `node demo/redteam.mjs --only A15`.

```
second live device on the same secret: welcome.streak 4, session 1000 coins - the same session
simultaneous plays from the two devices: round_opened | error:round_in_flight
```

**Impact.** The booth's address bar _is_ the credential. Anybody who photographs the screen, or
looks over a shoulder while staff open the page, holds a permanent bearer token for that booth and
can play its session - and take its coupons - from a phone anywhere on the internet. The session
itself is sound: the second device joins the _same_ server-side session, the streak cannot be
inflated, and the open-round index stops the two devices playing at once. But the secret is not
recoverable once leaked, only revocable, and the only signal that it leaked is coupons going
missing.

This is ticket **S3** ("kiosk secret out of the URL; scrub `k=` from Caddy logs"), queued. Until
it lands, the operational mitigation is: never show the address bar (kiosk mode, full screen),
`npm run kiosk:revoke` at the first sign of trouble, and check `coupons.claimed_by_kiosk` daily.

**File.** `src/api/socket.js` (`getKioskSecret`), `server/index.js` (`handleAuth`).

---

### D6 - `/status` and `/health` answer anyone - **Low** (a recorded decision worth revisiting)

**Reproduce.** `curl http://localhost:8787/status`.

```
/status keys: ok, uptimeSeconds, feed, sockets, rounds, flats24h, coupons, kiosksActive, db
answered with no credential of any kind: true
```

**Impact.** The Caddyfile says this is deliberate ("No secrets, so it is public exactly like
/health"), and it is right that there is no identity in there - the attack confirmed zero raw
addresses and zero uuids in either payload. One field is worth a second look anyway:
`coupons.available`. A booth visitor who reads it knows exactly how many $100 codes are left, which
is a number the campaign would rather own. `/health` additionally publishes raw upstream prices per
feed source, which is operationally useful and commercially uninteresting.

**Smallest fix.** Either drop `coupons` from the public `/status` body and keep it behind the
`/logs` basic_auth realm, or put `/status` behind the same realm and have `ops/index.html` prompt
once. Ticket **S12** already wants a coupon alert; this is the same number.

**Files.** `server/index.js` (`handleStatus`), `Caddyfile`.

---

### D7 - An empty `?k=` silently turns a booth into a web player - **Low** (tracked: S14)

**Closed by ticket S3.** The presence-not-truthiness fix below already stopped an empty secret
from being silently welcomed as a web player; ticket S3 closes the finding for good by deleting
the `?k=` code path it lives in - there is no longer a URL parameter to read at all. Nothing below
is rewritten - it is the finding as recorded.

**Reproduce.** `node demo/redteam.mjs --only A7`, or open `http://localhost:5347/?k=`.

```
guess empty -> no kiosk error - silently welcomed as a fresh WEB PLAYER
```

**Impact.** `handleAuth` branches on `if (frame.kiosk)`, and `''` is falsy, so an empty secret
falls through to the anonymous-player path and gets a `welcome` with a token. The client agrees
with itself - `IS_KIOSK = !!getKioskSecret()` is false for the same reason - so the booth renders
the _entire web app_: email capture, tasks, leaderboard, lead modal. That is precisely the hard
guarantee ticket C2 exists to make ("no email, task, leaderboard or lead-capture UI can render in
kiosk mode"), defeated by a truncated URL rather than by any client bug. A launch shortcut that
loses its query string, or a staff member who clears the address bar back to `/?k=`, is enough.

**Smallest fix.** Treat the parameter's _presence_ as the kiosk signal, not its truthiness:

```js
// server/index.js handleAuth
if (frame.kiosk !== undefined) {
  /* verify_kiosk, and fail closed */
}
```

```js
// src/api/socket.js
export const IS_KIOSK = apiEnabled && getKioskSecret() !== null;
```

An empty secret then fails `verify_kiosk`'s 16-character floor and the booth shows an error
instead of a shop front.

**Files.** `server/index.js`, `src/api/kiosk.js`.

---

### D8 - The `leaderboard` frame has no kind check - **Low**

**Reproduce.** `node demo/redteam.mjs --only A8`.

```
kiosk socket -> get_me      : error:unauthenticated
kiosk socket -> tasks       : error:not_available
kiosk socket -> claim_task  : error:not_available
kiosk socket -> free_refill : error:not_available
kiosk socket -> request_otp : error:not_available
kiosk socket -> verify_otp  : error:not_available
kiosk socket -> leaderboard : leaderboard ACCEPTED
```

**Impact.** Small, but it is an inconsistency in exactly the place the codebase is otherwise strict.
`server/index.js` is careful never to _push_ a leaderboard frame to a kiosk ("never a kiosk, which
has no email and is never ranked", and `test/integration-box/leaderboard.test.mjs` asserts it) - but
a kiosk socket that asks for one gets it. Since the kiosk secret is a URL-borne bearer token (D5),
that is a list of masked player addresses reachable by anyone holding a booth link. Masked, so the
exposure is low; inconsistent, so it will surprise whoever reads the code next.

**Smallest fix.** Add the same guard the neighbouring cases already have:

```js
case 'leaderboard': {
  if (kind !== 'player') { send(ws, { type: 'error', code: 'not_available' }); break; }
  ...
}
```

**File.** `server/index.js`.

---

### D9 - A raw Postgres SQLSTATE escapes as an error code - **Low**

**Reproduce.** `node demo/redteam.mjs --only A7`.

```
guess null byte splice -> error:22021
```

**Impact.** `handleFrame`'s catch sends `err.code || 'internal'`, and a `pg` error object carries
the SQLSTATE in `.code`. `mapError()` only renames the codes the game contract lists; everything
else passes through with its Postgres code intact. So a client can tell "the database rejected
this" from "the game rejected this", and can fingerprint the backend. It also breaks the frame
contract in `docs/box-spec.md`, which names the error codes a client may see - a client switching
on `frame.code` will fall to its default branch on a five-digit number it has never heard of.

**Smallest fix.** Only forward codes the contract owns:

```js
const code = ledger.KNOWN_ERROR_CODES.includes(err.code) ? err.code : 'internal';
send(ws, { type: 'error', code });
```

(`KNOWN_ERROR_CODES` already exists in `server/ledger.js`; it needs exporting.)

**Files.** `server/index.js`, `server/ledger.js`.

---

### D10 - Kiosk secret guessing is unthrottled - **Info**

Measured at 3.6 attempts/s with no lockout and no backoff. The only brake is bcrypt's cost factor,
and that brake is on the _server's_ CPU as much as the attacker's patience. A real secret is 32
random base64url characters, so guessing is not a route in; but the same unthrottled path is a
cheap way to burn server CPU, and it folds into the same fix as D2.

**File.** `server/index.js`.

---

## Held only because of something else

Two defences work today for reasons that are worth writing down, because a plausible change would
remove them.

- **A4 / A3 (two rounds at once) are held by a partial unique index, not by the server's socket
  bookkeeping.** `playerSockets` is a `Map` keyed by player id, so a second socket on the same
  token silently replaces the first in that map - the server does not notice it has two. What
  actually stops the double round is `uniq_open_round_per_player` in Postgres, caught as
  `unique_violation` and re-raised as `round_in_flight`. That is the right place for it, and it is
  pgTAP-covered. Just do not let anyone "tidy up" that index.
- **A14 (timing a flat) is held by economics, not by mechanism.** The server broadcasts its own
  `quiet` flag to every client on every price frame, which is exactly the signal a timing attack
  would want. It is harmless only because a flat pays zero and advances no streak. If a future
  ticket ever pays anything for a flat - a consolation coin, a streak that survives one - that
  broadcast becomes a free-money oracle on the same day.

## Not security, but found on the way

`docs/test-contract.md` has drifted from `db/schema.sql` in two places. A test author working from
the contract alone would write two failing tests:

- Rate limit: the contract says **60** rounds per player per rolling hour; `open_round()` enforces
  **400**.
- Leaderboard columns: the contract says `leaderboard()` exposes `display_name`; it returns
  `display` (the masked email), and `display_name` was deliberately dropped in C4 because returning
  it would defeat the masking.

The code is right in both cases. The contract needs the edit.

---

## Full run

```
node demo/redteam.mjs
```

```text
xChief Gold Rush - red team
server    ws://localhost:8787/ws / http://localhost:8787
database  postgresql://postgres:***@localhost:55447/postgres
started   2026-09-16T18:35:19.497Z

==============================================================================
A1  Client declares its own win, coins and coupon
------------------------------------------------------------------------------
ATTACK    send round_settled / me / kiosk_session / coupon frames upstream on an authed web socket
EXPECTED  server ignores unknown frame types; coins, wins and record unchanged
OBSERVED  db before coins=1000 wins=0 record=1000
          db after  coins=1000 wins=0 record=1000
          server reply to the forged frames: price, price, price, price, me
VERDICT   HELD - unknown frame types fall through index.js default: break

==============================================================================
A2  Client attaches its own stake, price, multiplier and reward
------------------------------------------------------------------------------
ATTACK    play{stake:-5000, coins:999999, start_price:1, mult:99, delta:50000}; claim_task{reward:1000000}
EXPECTED  every economic number comes from the database function; the extra fields are ignored
OBSERVED  round 1 outcome=win delta=100
          round 2 db row: stake=100 mult=1 start_price=4287.95
          round 2 frame: delta=-100 mult=1
          claim_task reply reward=300 (tasks.reward for instagram is 300)
          coins 1000 -> 1300
VERDICT   HELD - stake_for(lever) and tasks.reward are server-side

==============================================================================
A3  Two rounds at once on one identity (hedging up and down)
------------------------------------------------------------------------------
ATTACK    one socket sends play{up,1} and play{down,5} with no wait between them
EXPECTED  the second is refused round_in_flight - a partial unique index makes it impossible to hold two
OBSERVED  replies: round_opened, error:round_in_flight
          rounds still open for this player: 1
          rounds recorded in total: 1
VERDICT   HELD - uniq_open_round_per_player

==============================================================================
A4  Two sockets on one player token race a play
------------------------------------------------------------------------------
ATTACK    authenticate the same token twice, then send play{up} and play{down} at the same instant
EXPECTED  both sockets are the same player; exactly one round opens, the other gets round_in_flight
OBSERVED  second socket resolved to the same player id: true
          socket 1: round_opened
          socket 2: error:round_in_flight
          open rounds for the player: 1
VERDICT   HELD - the unique index arbitrates, not the socket bookkeeping

==============================================================================
A5  Dodge a loss: disconnect mid-round, reconnect, replay the play frame
------------------------------------------------------------------------------
ATTACK    play{up,5}; hard-kill the TCP socket 600 ms in; reconnect with the same token; send play again
EXPECTED  the first round settles on the server timer regardless; the replay is refused round_in_flight; the missed verdict is delivered exactly once
OBSERVED  first round opened: 8bb21949-5ce9-47ee-94d2-6259466cc304
          replay reply: error:round_in_flight
          pending verdict after reconnect: lose delta=-500 (round_settled frames on the new socket: 1)
          players.rounds 0 -> 1; round rows: lose
VERDICT   HELD - the 5 s timer lives in the server process, not the socket

==============================================================================
A6  Forged, expired and revoked player tokens
------------------------------------------------------------------------------
ATTACK    8 hand-minted tokens for a victim's uuid (bad hmac, guessed secrets, expired, wrong version, legacy shape)
EXPECTED  every one is treated exactly like no token: a brand-new anonymous player, never an error and never the victim
OBSERVED  unsigned (no hmac at all)                      -> fresh player fe6b2e09 coins=1000
          hmac under a guessed secret                    -> fresh player be66545d coins=1000
          hmac under the literal "PLAYER_TOKEN_SECRET"   -> fresh player 0c694e02 coins=1000
          legit shape, expired yesterday                 -> fresh player 4f56efdc coins=1000
          legit shape, version bumped to 99              -> fresh player 293115ab coins=1000
          old two-field format id.sig                    -> fresh player 413ed26f coins=1000
          signature flipped one nibble                   -> fresh player 405e6005 coins=1000
          victim id with no signature field              -> fresh player 396ed497 coins=1000
          control: correctly signed, current version     -> victim, coins=50000
VERDICT   HELD - timing-safe hmac compare, expiry and token_version all checked

==============================================================================
A7  Kiosk secret: guessing, length floor, reuse after revoke
------------------------------------------------------------------------------
ATTACK    9 crafted secrets + 30 sequential brute-force attempts; and one secret replayed after kiosk:revoke
EXPECTED  every wrong or revoked secret gets kiosk_unauthorized; a revoked kiosk can never authenticate again
OBSERVED  active secret before revoke   -> welcome (authorised)
          same secret after kiosk:revoke -> error:kiosk_unauthorized
          guess empty                                    -> no kiosk error - silently welcomed as a fresh WEB PLAYER
          guess short "kiosk"                            -> error:kiosk_unauthorized
          guess 15 chars (under the floor)               -> error:kiosk_unauthorized
          guess 16 chars of a                            -> error:kiosk_unauthorized
          guess dev-kiosk-secret-0002 (next in series)   -> error:kiosk_unauthorized
          guess dev-kiosk-secret-0000                    -> error:kiosk_unauthorized
          guess sql wildcard                             -> error:kiosk_unauthorized
          guess sql injection in the secret              -> error:kiosk_unauthorized
          guess null byte in the secret                  -> error:22021
          unthrottled guess rate measured: 3.6 attempts/s, no lockout, no backoff (bcrypt cost is the only brake)
VERDICT   PARTIAL - no secret was guessed and revoke is enforced inside verify_kiosk's own where-clause; but an empty ?k= is falsy in handleAuth, so a booth whose launch URL loses its secret is silently welcomed as a web player instead of being refused (1 case)

==============================================================================
A8  Web frames on a kiosk socket, kiosk frames on a web socket
------------------------------------------------------------------------------
ATTACK    kiosk_reset from a web socket; get_me/tasks/claim_task/free_refill/request_otp/verify_otp/leaderboard from a kiosk socket
EXPECTED  every cross-mode frame is refused not_available; a kiosk has no player identity to act on
OBSERVED  web socket -> kiosk_reset : error:not_available
          kiosk socket -> get_me      : error:unauthenticated
          kiosk socket -> tasks       : error:not_available
          kiosk socket -> claim_task  : error:not_available
          kiosk socket -> free_refill : error:not_available
          kiosk socket -> request_otp : error:not_available
          kiosk socket -> verify_otp  : error:not_available
          kiosk socket -> leaderboard : leaderboard ACCEPTED
            the kiosk's leaderboard frame carried 0 rows, fields: (empty board)
VERDICT   PARTIAL - all player frames gated, but `leaderboard` has no kind check and answers a kiosk socket

==============================================================================
A9  Claim the same task twice, fast (two sockets, and two frames in one tick)
------------------------------------------------------------------------------
ATTACK    two sockets on one token both send claim_task{telegram}; then one socket sends claim_task{youtube} twice with no await
EXPECTED  exactly one claim row and one reward per task; the loser gets already_claimed
OBSERVED  two sockets: me reward=300 | error:already_claimed
          one socket twice: error:already_claimed | me reward=300
          task_claims rows: telegram=1, youtube=1
          coins 1000 -> 1600 (telegram 300 + youtube 300 = 600 expected)
VERDICT   HELD - claim_task takes `for update` on the players row before its own eligibility check

==============================================================================
A10  Take the one-time free refill twice
------------------------------------------------------------------------------
ATTACK    two sockets on one token send free_refill simultaneously; then a third attempt after coins are pushed low again
EXPECTED  exactly one grant of +300; every later call is already_refilled
OBSERVED  simultaneous: me coins=350 reward=300 | error:already_refilled
          db after the race: coins=350 free_refill_used=true
          third attempt: error:already_refilled; db coins=10
VERDICT   HELD - free_refill() locks the players row before reading free_refill_used

==============================================================================
A11  OTP: unlimited code requests, and brute-forcing a code
------------------------------------------------------------------------------
ATTACK    40 request_otp for one address as fast as the socket allows; 7 wrong codes; a fresh request to reset the attempt counter; then 10 requests aimed at a third party's address
EXPECTED  a code cannot be guessed (5 attempts per code, 10^8 space); requests are rate limited per email and per connection
OBSERVED  40 request_otp accepted in 1242 ms (32.2/s), zero refusals; otp_codes rows for the address: 40
          wrong-code guesses: invalid_code, invalid_code, invalid_code, invalid_code, too_many_attempts, invalid_code, invalid_code
          after a new request_otp, guess 1 of 5 again: invalid_code
          guesses still accepted after that lockout, without requesting anything more: 120 (a superseded code is never invalidated, so verify_otp_code walks down the pile of 40 outstanding codes, 5 guesses each); still live: 16
          request_otp aimed at victim-who-never-played@example.com: 10/10 accepted (each would be a real send once ELASTIC_API_KEY is set)
VERDICT   PARTIAL - the code itself held (8 digits, sha256 at rest, 5 guesses each); but request_otp has no rate limit at all, and every request piles on another still-valid code - so the guess budget is 5 x (codes requested), unbounded, and each request is a real email to an address the requester does not own

==============================================================================
A12  Take over someone else's verified email
------------------------------------------------------------------------------
ATTACK    a fresh player tries to verify a victim address with an empty, missing, null, object, injected and foreign code; then with the code actually mailed to the victim
EXPECTED  nothing but the code mailed to that address works; and that path is a login into the victim, not a merge or a theft of their row
OBSERVED  victim verified as r****5@example.com (record set to 99999)
          verify with an empty code                            -> error:expired_code
          verify with a guess, no request first                -> error:expired_code
          verify with no code field at all                     -> error:expired_code
          verify with code=null                                -> error:expired_code
          verify with code as an object                        -> error:internal
          sql injection in the code                            -> error:expired_code
          sql injection in the email                           -> error:expired_code
          own valid code replayed on the victim's email        -> error:expired_code
          code actually mailed to the victim (inbox access assumed) -> me id=ff666ed6 email=redteam-victim-1789583780125@example.com
          re-login landed on the victim's player: true (docs/layers.md C3a: the code proved ownership, so this is the intended re-login)
VERDICT   HELD - the otp_codes row is looked up by (player_id, email) and compared by sha256; nothing crosses over

==============================================================================
A13  leaderboard and /status leaking raw emails or player ids
------------------------------------------------------------------------------
ATTACK    read the leaderboard frame as an anonymous player, and GET /status and /health with no credential
EXPECTED  masked emails only, no raw address, no player or kiosk uuid, no secret
OBSERVED  leaderboard row fields: display, record, rank
          leaderboard sample: [{"display":"r****5@example.com","record":99999,"rank":"1"}]
          raw addresses of 1 verified players found in either payload: 0
          uuid anywhere in the leaderboard frame: false; in /status: false
          /status keys: ok, uptimeSeconds, feed, sockets, rounds, flats24h, coupons, kiosksActive, db
          /health keys: ok, feed, db (feed source names and raw upstream prices, no identity)
          /status and /health answered with no credential of any kind: true
VERDICT   PARTIAL - masking happens in SQL (mask_email) so a raw address never leaves the database; but /status and /health are unauthenticated - operator aggregates, coupon stock and feed health for anyone who asks

==============================================================================
A14  Force a flat by timing the play
------------------------------------------------------------------------------
ATTACK    watch the server-published `quiet` flag on every price frame, then open rounds and see whether a client-chosen instant can produce a guaranteed flat
EXPECTED  a flat costs nothing and pays nothing, so timing one is at best a refusal to bet - never a way to win
OBSERVED  price frames seen: 28, of which quiet: 0; feed quiet right now: false
          4 timed rounds: lose, lose, win, lose; flats over this player's whole history: 0/4
          both prices are read by the server from feed.latest() (server/rounds.js); the client supplies neither and cannot delay the 5 s timer
          a flat leaves coins, streak and record untouched (settle_round), so a perfectly timed flat achieves a round that did not happen
VERDICT   HELD - the `quiet` flag is published to clients, so a patient client can skew towards flats - but a flat pays zero, so there is no profit and no streak in it

==============================================================================
A15  Kiosk at a 4-win streak: reconnect to keep or inflate it
------------------------------------------------------------------------------
ATTACK    set the streak to 4, drop the socket, reconnect; re-send auth five times on a live socket; then open a second simultaneous socket on the same secret and race a play
EXPECTED  the streak survives a reconnect (it is server session state) but cannot be inflated, and two devices on one secret share exactly one session
OBSERVED  reconnect: welcome.streak 4 -> 4; kiosk_session streak 4 -> 4
          second live device on the same secret: welcome.streak 4, session 1000 coins - the same session, not a second one
          5 re-auths on a live socket: replies price,price,price,price,price; streak after: 4
          simultaneous plays from the two devices: round_opened | error:round_in_flight
          final streak=0 coins=900
VERDICT   PARTIAL - streak and coins are server state keyed by kiosk id, so a reconnect cannot inflate them - but the bearer secret rides in the launch URL (?k=), so anyone who photographs the booth address bar gets a live session on the booth from their own phone (ticket S3)

==============================================================================
A16  Dodge a kiosk loss by resetting the session mid-round
------------------------------------------------------------------------------
ATTACK    open a kiosk round with a 200-coin pot, then send kiosk_reset before the 5 s timer fires
EXPECTED  a round in flight is settled against the session that staked it; a reset ends the session for good - a late verdict cannot refund the stake or drag the machine back out of attract mode
OBSERVED  pot at open: 200 (playing); round b0a7d8fe-85e0-4768-96c9-155195303e7c
          kiosk_reset reply: coins=1000 state=idle
          verdict that still arrived: lose delta=-100 coins=900 state=playing
          pot after: 900 state=playing streak=0
          pot had the reset not landed: 100 - actual 900, so the stake at risk was re-based onto the fresh 1000-coin pot (800 coins out of nothing)
          the reset put the machine in 'idle' (attract) and the late verdict put it back in 'playing'
VERDICT   LOOPHOLE - kiosk_reset does not cancel the round it is standing on: the verdict lands 5 s later on the new session, re-basing the pot and pulling the screen back out of attract mode into a stranger's result

==============================================================================
A17  Influence the start or end price
------------------------------------------------------------------------------
ATTACK    send price/hello/tick frames upstream, then play with start_price:1, price:1 and end_price:999999 attached
EXPECTED  both prices are read by the server from its own feed; nothing a client sends reaches rounds.start_price or rounds.end_price
OBSERVED  feed price at open (from /status): 4274.4; rounds.start_price recorded: 4274.4 (source okx)
          feed price at settle: 4274.65; rounds.end_price recorded: 4274.65
          verdict: win start=4274.4 end=4274.65
          index.js reads only frame.dir and frame.lever off a play frame; server/rounds.js supplies the price from feed.latest()
VERDICT   HELD - the price arguments are never client-reachable

==============================================================================
A18  Two kiosks hit a 5-win streak at the same instant with one coupon left
------------------------------------------------------------------------------
ATTACK    four kiosks preset to streak 4, exactly one available coupon, two play up and two play down so the winning pair settles within milliseconds of each other
EXPECTED  exactly one coupon is issued; the other winner keeps its streak and is told the pool is exhausted; the code is never handed out twice
OBSERVED  outcomes: k0=lose k1=lose k2=win k3=win (winners this round: 2)
          coupons issued: REDTEAM-LAST-CODE
          coupons_exhausted reported to: 1 kiosk(s)
          coupons row: REDTEAM-LAST-CODE claimed by 450a1b75
          streaks after: 0/won 0/playing 0/playing 5/playing
VERDICT   HELD - a genuine two-winner race: `for update skip locked` over the available pool gave the code to exactly one

==============================================================================
A19  Message flood from one socket
------------------------------------------------------------------------------
ATTACK    20000 get_me frames pushed down one socket with no pacing (each one is a database round-trip)
EXPECTED  a per-socket rate limit or flood cut-off refuses the burst; other players stay responsive
OBSERVED  20000 frames queued in 441 ms; the socket was never closed or throttled by the server
          me replies received back: 20000/20000 over the next 45128 ms (443 db round-trips/s sustained); error frames: 0
          server still healthy afterwards: true (db true)
          a bystander connecting during the flood: welcome in 39 ms, play -> round_opened
          feed was connected before the flood: {"okx":{"connected":true,"lastTickAt":1789583835110,"raw":4272.25},"binance":{"connected":
VERDICT   LOOPHOLE - there is no per-socket rate limit (ticket S2 is queued, not built): one socket forces unbounded database round-trips. The server survived this burst, but nothing in the code stops a larger or sustained one

==============================================================================
A20  Oversized and malformed frames
------------------------------------------------------------------------------
ATTACK    13 malformed payloads (bad JSON, wrong types, injection-shaped values, 2000-deep nesting) and one 64 MB frame
EXPECTED  malformed input is ignored or answered with an error code; an absurd frame is refused before it is buffered
OBSERVED  not JSON at all                    -> ignored (no reply)
          JSON null                          -> ignored (no reply)
          JSON array                         -> ignored (no reply)
          type is a number                   -> ignored (no reply)
          type is an object                  -> ignored (no reply)
          no type field                      -> ignored (no reply)
          dir as an array                    -> error:bad_dir
          lever 3 (not a valid lever)        -> error:bad_lever
          lever 2^31-1                       -> error:bad_lever
          lever as a string                  -> round_opened
          task_id as an object               -> error:unknown_task
          email 100k chars                   -> error:invalid_email
          deeply nested json (2000 levels)   -> ignored (no reply)
          64 MB single frame                 -> me after 725 ms - ACCEPTED: buffered, JSON.parsed and acted on
          socket still open after all of the above: true
          server still answering /health: true
VERDICT   PARTIAL - parsing and type handling held - every malformed frame was ignored or answered with a code, and the process stayed up. But no maxPayload is set on the WebSocketServer, so the `ws` default of 100 MB applies: each open socket can make the server buffer and JSON.parse a 100 MB string on demand

==============================================================================
A21  Service-only SQL called as the client role (the box equivalent of the anon key)
------------------------------------------------------------------------------
ATTACK    set role anon, then read kiosks/coupons/otp_codes/players and call every service-role function directly
EXPECTED  every service-role function and table is denied to anon; only leaderboard() answers
OBSERVED  select * from public.kiosks                  -> denied: permission denied for table kiosks
          select * from public.coupons                 -> denied: permission denied for table coupons
          select * from public.otp_codes               -> denied: permission denied for table otp_codes
          select * from public.dev_otps                -> denied: permission denied for table dev_otps
          select id from public.players                -> no rows: RLS returns nothing to anon (0 rows)
          select * from public.rounds                  -> no rows: RLS returns nothing to anon (0 rows)
          select * from public.task_claims             -> no rows: RLS returns nothing to anon (0 rows)
          update public.players set coins              -> denied: permission denied for table players
          insert into public.coupons                   -> denied: permission denied for table coupons
          open_round(...)                              -> denied: permission denied for function open_round
          settle_round(...)                            -> denied: permission denied for function settle_round
          verify_kiosk(...)                            -> denied: permission denied for function verify_kiosk
          open_kiosk_round(...)                        -> denied: permission denied for function open_kiosk_round
          settle_kiosk_round(...)                      -> denied: permission denied for function settle_kiosk_round
          request_otp_code(...)                        -> denied: permission denied for function request_otp_code
          verify_otp_code(...)                         -> denied: permission denied for function verify_otp_code
          revoke_player_sessions(...)                  -> denied: permission denied for function revoke_player_sessions
          ensure_player(...)                           -> denied: permission denied for function ensure_player
          leaderboard() [expected: allowed]            -> ALLOWED (1 rows)
VERDICT   HELD - the grants block at the end of db/schema.sql is doing its job; 172 pgTAP assertions cover it as a regression

==============================================================================
A22  The unauthenticated HTTP surface (/api/lead)
------------------------------------------------------------------------------
ATTACK    post malformed, injected and 64 MB bodies to /api/lead with no credential of any kind
EXPECTED  validation rejects bad input, and a body size limit rejects an absurd one before it is buffered
OBSERVED  valid lead                     -> 204 in 6 ms
          invalid email                  -> 400 in 3 ms
          crlf injection in the email    -> 400 in 0 ms
          garbage body                   -> 400 in 1 ms
          64 MB body                     -> 204 in 593 ms
          server still answering /health: true
          no auth, no origin check and no rate limit on POST /api/lead; readJsonBody() buffers the whole body before parsing it
VERDICT   PARTIAL - email validation held (the CRLF address is refused because EMAIL_RE excludes whitespace), but the body is read with no size cap and the endpoint has no rate limit - the same memory-pressure lever as the missing WebSocket maxPayload

==============================================================================
A23  The DEV cheat hook (window.__xchief.inject) in a production build
------------------------------------------------------------------------------
ATTACK    npm run build, then grep every emitted bundle for __xchief, kioskTiming and settledCount
EXPECTED  import.meta.env.DEV is statically false in a production build, so Rollup drops the hook entirely - a shipped client has no way to inject a frame
OBSERVED  build: ✓ built in 786ms
          bundles scanned: 3 (af-DigemgIo.js 12 kB, Logo-Ciy-ZiPv.js 141 kB, main-Co_-CUC6.js 80 kB)
          matches for __xchief / kioskTiming / settledCount: none
          dist/ removed again
VERDICT   HELD - the hook is dead-code-eliminated; it exists only under `npm run dev`

==============================================================================
SUMMARY
==============================================================================
ID   ATTACK                                                                          VERDICT
A1   Client declares its own win, coins and coupon                                   HELD
A2   Client attaches its own stake, price, multiplier and reward                     HELD
A3   Two rounds at once on one identity (hedging up and down)                        HELD
A4   Two sockets on one player token race a play                                     HELD
A5   Dodge a loss: disconnect mid-round, reconnect, replay the play frame            HELD
A6   Forged, expired and revoked player tokens                                       HELD
A7   Kiosk secret: guessing, length floor, reuse after revoke                        PARTIAL
A8   Web frames on a kiosk socket, kiosk frames on a web socket                      PARTIAL
A9   Claim the same task twice, fast (two sockets, and two frames in one tick)       HELD
A10  Take the one-time free refill twice                                             HELD
A11  OTP: unlimited code requests, and brute-forcing a code                          PARTIAL
A12  Take over someone else's verified email                                         HELD
A13  leaderboard and /status leaking raw emails or player ids                        PARTIAL
A14  Force a flat by timing the play                                                 HELD
A15  Kiosk at a 4-win streak: reconnect to keep or inflate it                        PARTIAL
A16  Dodge a kiosk loss by resetting the session mid-round                           LOOPHOLE
A17  Influence the start or end price                                                HELD
A18  Two kiosks hit a 5-win streak at the same instant with one coupon left          HELD
A19  Message flood from one socket                                                   LOOPHOLE
A20  Oversized and malformed frames                                                  PARTIAL
A21  Service-only SQL called as the client role (the box equivalent of the anon key) HELD
A22  The unauthenticated HTTP surface (/api/lead)                                    PARTIAL
A23  The DEV cheat hook (window.__xchief.inject) in a production build               HELD

HELD: 14   PARTIAL: 7   LOOPHOLE: 2
finished 2026-09-16T18:38:15.229Z (176 s)
```
