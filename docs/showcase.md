# The showcase

`demo/showcase.mjs` walks the whole product in front of you: one Chromium, three tiled windows -
**Kiosk A**, **Kiosk B** and **Web** - thirteen scenarios, at a speed a person can follow. Every
scenario opens with a caption card in its own window saying what to watch, then acts: roughly
0.6-0.9 s between taps, 1.5 s wherever you would stop and read.

It is not a video. It is the real client talking to the real server, and each scenario ends by
checking the thing it just showed you - usually by asking the server the same question over a
second, independent socket, so the check cannot be fooled by whatever the page is rendering.

Two things are staged, and the caption says so on screen both times:

- **Scenario 8 (five wins in a row).** Five real wins in a row is luck; you cannot schedule it.
  The five verdicts are fed in through the DEV-only `window.__xchief.inject` hook - the same
  frame shape the server sends, through the same client handler. Only the input is synthetic;
  no coupon is actually claimed.
- **Any scenario that needs a specific balance** (6, 9, 11). The server owns every coin, so
  there is no client path to a number. Those balances are set straight in the database, which is
  exactly what the existing E2E specs do for the same reason.

Everything else - the rounds, the verdicts, the login code, the leaderboard push, the task
reward, the idle sweep - is the system doing its own work.

## How to run it

You need Docker, Node 20+, and Playwright (already installed in this repo).

**1. A database of its own.** `db/run-tests-demo.sh` is `db/run-tests.sh` with one difference:
host port `55447` and a container named `goldrush-demo-keep`, so it will not fight with a
`goldrush-box-keep` container somebody else left on `55432`.

```bash
bash db/run-tests-demo.sh --keep
```

That builds a stock `postgres:16`, applies `db/schema.sql` and `db/seed.sql`, runs the 172
pgTAP assertions (they should all pass), and leaves the container up. It prints the connection
string you want:

```
DATABASE_URL=postgresql://postgres:test@localhost:55447/postgres
```

**2. The game server.** Port 8787, matching `VITE_GAME_WS` in `.env`. Leave `FINNHUB_TOKEN` and
`ELASTIC_API_KEY` unset: the feed then runs on the free OKX/Binance sources, and login codes are
captured in `public.dev_otps` instead of being mailed, which is what `scripts/peek-otp.mjs`
reads. `KIOSK_OPEN_PROVISION=1` turns on `/kiosk` (ticket K1); both kiosk windows need it.

```bash
DATABASE_URL=postgresql://postgres:test@localhost:55447/postgres \
  PLAYER_TOKEN_SECRET=dev-secret PORT=8787 KIOSK_OPEN_PROVISION=1 npm run server
```

**3. The client.** A Vite dev server on a port nothing else is using:

```bash
npx vite --port 5347 --strictPort
```

The dev server matters: `window.__xchief` only exists under `import.meta.env.DEV`, so scenarios
8, 10, 11 and 12 need it. A production build has no such hook - `demo/redteam.mjs` A23 proves
that by building and grepping the bundle.

**4. The showcase.**

```bash
DATABASE_URL=postgresql://postgres:test@localhost:55447/postgres node demo/showcase.mjs
```

Three windows open, tiled left to right. It runs for about four and a half minutes (the last
recorded run was 256 s). At the end it prints a results table and writes
`docs/reports/showcase-results.md` with a timestamp on every scenario.

Options:

| Option          | Meaning                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `--only 4,8,11` | Run a subset. Every scenario sets up its own world, so any subset works. |
| `--base URL`    | App base URL (default `http://localhost:5347`).                          |
| `--ws URL`      | Game socket (default `ws://localhost:8787/ws`).                          |
| `--fast`        | Halve the pacing. For a dry run, not for showing anybody.                |

**Afterwards.** Stop the server and Vite, then `docker rm -f goldrush-demo-keep`.

**Two kiosks.** Both kiosk windows open the open route (`/kiosk`) and self-provision on load
(ticket K1) - there is no seeded secret in the URL - so Kiosk A and Kiosk B are genuinely
different booths with separate server-side sessions from the moment they load. The server must
run with `KIOSK_OPEN_PROVISION=1` or neither can provision. `db/seed.sql`'s own dev kiosk
(`dev-kiosk-secret-0001`) is unrelated to this script - it exists for tests that authenticate a
kiosk directly over the socket, never through a browser.

---

## The scenarios

Each section below says: what you are looking at, what the server is doing underneath, what
would look different if the system were broken, and which test already covers it.

### 1. A first round, decided by the server - _Web_

**On screen.** Home, then the play console. Up is pressed, a countdown runs, a verdict appears,
the balance chip changes.

**Underneath.** The click sends one frame: `play {dir, lever}`. Nothing else. The server reads
the current XAU/USD price off its own feed, writes a `rounds` row through `open_round()`, and
arms a 5-second timer _in the server process_. When it fires, the server reads the price again,
and `settle_round()` decides win, loss or flat and moves the coins. The client is told the answer
in a `round_settled` frame; it has no opinion of its own. The scenario then opens a second
WebSocket, authenticates with the same player token, sends `get_me`, and checks that the number
on screen equals the number in the database.

**If it were wrong.** A verdict arriving in under ~4.5 s would mean something other than the
server's timer decided it. A balance on screen that does not match `get_me` would mean the client
is keeping its own books. Both are hard failures here.

**Covered by.** `tests/e2e/player-promises.spec.js` #1.

### 2. Reload in the middle of a round - _Web_

**On screen.** A round starts; one second in, the page reloads and comes back blank-slate. The
round is gone from the screen.

**Underneath.** The socket dies, the browser forgets everything - and the server's timer keeps
running, because it never lived in the browser. The round settles on schedule. The verdict has
nowhere to go, so `server/rounds.js` parks it as this identity's one pending verdict and hands it
over right after the next `welcome`. The scenario polls `get_me` until `players.rounds` moves and
checks it moved by exactly one, for exactly the same player id.

**If it were wrong.** `rounds` unchanged would mean pulling the plug is a free escape from a
loss. `rounds` up by two, or a new player id, would mean a reload buys a retry or a fresh
balance. This is the promise a booth cannot afford to get wrong.

**Covered by.** `tests/e2e/player-promises.spec.js` #2; `test/integration-box/server.test.mjs`
("disconnect right after round_opened still settles").

### 3. Signing in with an emailed code - _Web_

**On screen.** The leaderboard's guest row opens the code modal. An email goes in, then a
deliberately wrong code - which is refused inline, in the modal, with the page unchanged. Then
the real code, and the header turns into `Playing as y****f@example.com` - masked, never the
address that was typed.

**Underneath.** `request_otp` makes the server generate an 8-digit code, store **only its
sha256**, and hand the plain code to the mailer. With no `ELASTIC_API_KEY` the mailer writes it
to `public.dev_otps` instead of sending it, and the scenario reads it back with
`node scripts/peek-otp.mjs <email>` - the same command a human tester uses. The code is never
guessed and never read out of the page. A wrong code increments the attempt counter on that code;
the fifth wrong guess burns it.

**If it were wrong.** A raw address in the header instead of a mask would mean the masking is
client-side and therefore optional. A wrong code being accepted, or the modal accepting anything
before the server answers, would mean the client is deciding who you are.

**Covered by.** `tests/e2e/web-identity.spec.js`; `test/integration-box/otp.test.mjs`.

### 4. The leaderboard, masked and live - _Web_

**On screen.** The board with your own row highlighted, showing a masked address. Then, without
anyone touching the window, a new row arrives above yours and the list re-orders.

**Underneath.** `public.leaderboard()` computes the mask in SQL with `mask_email()`, so a raw
address never leaves the database. The live part is real: the scenario builds a rival player
entirely over the socket (anonymous auth, `request_otp`, the dev-captured code, `verify_otp`) and
has it play one genuine round. When that round **settles**, `server/index.js` recomputes the top
10 and pushes a `leaderboard` frame to every web socket - debounced to at most once a second, and
never to a kiosk. The window you are watching redraws from that frame.

The rival's `record` is seeded in the database first, so the push is guaranteed to change the top
10 rather than depending on the market. The _push_ is real; the reason it matters is arranged.

One piece of housekeeping in this scenario is there for a known product gap, not for the demo.
The leaderboard decides "is this my row" by comparing masked addresses, so two players whose local
parts share a first and last letter both get highlighted (`docs/TRACKER.md` gap G3, carded against
ticket B2). The showcase therefore gives its player and its rival random first and last letters,
and retires earlier runs' demo identities off the board at startup. If a collision happens anyway
the scenario fails with that gap named, rather than with an obscure "two elements matched".

**If it were wrong.** A raw address anywhere on the board. Your own row losing its highlight
after a push. Or the board only changing when you navigate away and back - which would mean there
is no live channel at all, just a fetch on screen entry.

**Covered by.** `tests/e2e/web-identity.spec.js`; `test/integration-box/leaderboard.test.mjs`
("a settled round that changes the top 10 pushes a leaderboard frame", "a leaderboard push never
reaches a kiosk socket").

### 5. Claiming a task reward - _Web_

**On screen.** The tasks list, one task opened, its timer runs out, Claim is pressed. A `+300`
toast, the task flips to claimed, the balance chip goes up.

**Underneath.** The client sends `claim_task {task_id}` and nothing else - no amount. The reward
lives in `public.tasks` and `claim_task()` reads it there, takes a row lock on the player,
re-checks eligibility, inserts the claim and credits the coins in one transaction. The reply is
`{type:'me', ...me, reward}`; the toast prints the server's `reward`, and the chip prints the
server's `coins`. The scenario checks the granted amount against `get_me` on a second socket, and
checks that the toast is showing that same number.

**If it were wrong.** A toast showing a number from `src/config.js` rather than the server's
reply. A balance that drifts from `get_me`. Either would mean the reward table is client-side and
therefore editable in a browser console.

**Covered by.** `tests/e2e/player-promises.spec.js` #4; `test/integration-box/tasks.test.mjs`.

### 6. Broke on the web is never a dead end - _Web_

**On screen.** The balance reads 50 - not enough for the smallest stake - and an overlay explains
the way out. The refill is taken; the overlay clears and the direction buttons come back to life
with no reload.

**Underneath.** The 50 is written straight into `players.coins`. That is deliberate: the server
owns coins, there is no client path to a specific number, and losing rounds for real until you
hit 50 is slow and random. The client only learns about it through a frame it already trusts.
The refill itself is entirely server-side: `free_refill()` locks the player row, refuses if
`free_refill_used` is already true or if coins are at 100 or more, and only then grants 300 and
sets the flag. The scenario checks `free_refill_used` is true afterwards and that the chip matches
`get_me`.

**If it were wrong.** The overlay showing a number the server does not have. A refill that can be
taken twice (`demo/redteam.mjs` A10 attacks exactly that). Or the overlay surviving the refill,
which is the dead end ticket C7 was written to remove.

**Covered by.** `tests/e2e/player-promises.spec.js` #5; `test/integration-box/tasks.test.mjs`
("free_refill grants its reward once eligible, then rejects a second call").

### 7. The booth: attract, tap, play, verdict - _Kiosk A_

**On screen.** The attract screen. A tap, then one real round against the live gold price:
countdown, verdict, balance.

**Underneath.** Opening `/kiosk` self-provisions a bearer secret and stores it on the device
(ticket K1); it never rides in the URL (ticket S3). On connect, the server calls `verify_kiosk()`,
which bcrypt-compares it against the stored hash - the raw secret is never stored server-side and
never recoverable. From then on the booth has a server-owned visitor session: coins,
streak, state, all in `public.kiosks`, all decided by `settle_kiosk_round()`. The scenario also
counts the web-only UI in the DOM, at the attract screen and again at the verdict: `.lead`,
`.signup`, `.lb`, `.tasks`, `.nav`, `input[type=email]`. It must be zero every time.

**If it were wrong.** Any email field, task, leaderboard or nav bar on a booth screen - the
registration modal that appeared during the ten-minute run and became ticket C2. It holds by
construction now: `KioskApp.jsx` does not import any of those components.

**Covered by.** `tests/e2e/kiosk.spec.js` #1; `tests/e2e/player-promises.spec.js` #3.

### 8. Five wins in a row wins the code - _Kiosk A_ (staged)

**On screen.** Four wins, the balance climbing each time, then the fifth: a full-screen modal,
"You won!", the code on one line, large, and a Claim button. Claim returns the booth to attract.

**Underneath - and this is the staged one.** Five real wins in a row cannot be scheduled, so the
five verdicts enter through `window.__xchief.inject` (`src/api/socket.js`, DEV-only). They are the
exact frame shape `server/rounds.js` sends, run through the exact client handler a real frame
takes. Nothing about the rendering is bypassed - only the input is synthetic, and no coupon is
actually claimed.

What the real path does, and what the tests below prove: on the fifth server-validated win,
`settle_kiosk_round()` claims one coupon in a single statement -
`update ... where id = (select id from coupons where status='available' order by created_at limit 1 for update skip locked)` -
so two booths reaching five at the same instant get one code and one "pool empty", never the same
code twice. `demo/redteam.mjs` A18 races four booths at that exact moment and confirms it.

**If it were wrong.** The code wrapping onto two lines (it is photographed off the screen, so the
scenario asserts exactly one client rect). Email or leaderboard UI visible behind the modal. Or
Claim leaving the booth in the won state for the next visitor.

**Covered by.** `tests/e2e/kiosk.spec.js` #4; `tests/e2e/streak.spec.js`;
`test/integration-box/streak.test.mjs` (the real coupon claim, `session_over`, and the empty-pool
case).

### 9. Out of coins: the exit modal - _Kiosk B_

**On screen.** The pot is below the smallest stake. A play is attempted and instead of a round,
the exit modal: "That was your shot… you have used all your coins." Done returns to attract.

**Underneath.** The pot is set to 50 in the database, for the same reason as scenario 6. The
refusal is the server's: `open_kiosk_round()` sees the session cannot cover the stake, marks it
`broke` and returns `insufficient_coins`. `server/index.js` then pushes the updated
`kiosk_session` frame, and that frame - not any client decision - is what puts the modal on
screen. On a kiosk, `insufficient_coins` means "session over", never "buy more".

**If it were wrong.** A "try again" loop instead of an ending. A modal the client raised on its
own count of the coins. Or Done leaving the session mid-state for the next person.

**Covered by.** `tests/e2e/kiosk.spec.js` #2; `test/integration-box/server.test.mjs` ("a lever the
session cannot cover ends it as broke; the session then refuses play until reset").

### 10. Walked away: the idle countdown - _Kiosk B_ (staged timing)

**On screen.** Nobody touches the booth. "Still there? Resetting in N…" appears. A mouse move
cancels it instantly. Left alone the second time, it counts to zero and flushes back to attract.

**Underneath.** The product rule is 20 s of no activity, then a 20 s countdown - 40 s total,
deliberately ahead of the server's own 60 s safety net so the two never race. Waiting 40 s twice
makes a poor demo, so `window.__xchief.kioskTiming` shrinks it to 4 s + 6 s. Only the two
constants change; the state machine in `src/useKioskFlow.js` is untouched. At zero the client
sends `kiosk_reset` and the server clears the session.

Activity means anything a present human does anywhere on the page - pointer move, tap, key,
touch - on passive listeners, so the game never feels laggy because of the idle tracker.

**If it were wrong.** A countdown that a mouse move does not cancel (a visitor mid-thought loses
their game). A countdown that never appears (the booth sits on a stranger's dead session). Or a
flush that leaves per-visitor state on the attract screen.

**Covered by.** `tests/e2e/kiosk.spec.js` #5.

### 11. The server's own idle sweep, with no client help - _Kiosk B_

**On screen.** The booth is on the play screen. Nothing is pressed. It returns to attract by
itself.

**Underneath.** The client's countdown is switched off first - `kioskTiming` is set to an hour -
so whatever happens next cannot be the browser's doing. Then `kiosks.last_round_at` is pushed 90
seconds into the past. `server/kiosk.js` sweeps every 10 s for active kiosks whose session is not
idle and whose last round is older than 60 s, calls `reset_kiosk_session()`, and pushes the
resulting `kiosk_session` frame down the live socket. The scenario asserts the booth was on the
play screen and the server session was `playing` before it starts waiting, so a pass cannot be an
accident.

**If it were wrong.** Nothing would happen. That is the failure mode this exists for: a visitor
walks away and the browser is gone, crashed or asleep, so the client countdown never runs. Without
the sweep the booth would hold that person's session until somebody notices.

**Covered by.** `test/integration-box/server.test.mjs` ("the idle sweep resets a stale kiosk
session and pushes kiosk_session without a client action"); `tests/e2e/kiosk.spec.js` #3 covers
the client's side of the same frame.

### 12. The winning code stays on screen long enough to photograph - _Kiosk A_

**On screen.** The win modal, and then 25 seconds of nothing at all. The code is still there at
the end.

**Underneath.** The product rule is a 30-second timer on the win modal. The contract this
scenario guards is the floor: the modal must not close early, because a visitor is getting their
phone out. The modal's countdown is in `src/useKioskFlow.js` and is purely cosmetic - it ends the
session by sending `kiosk_reset`, it never decides anything.

**If it were wrong.** The code vanishing while somebody is still focusing a camera. It happens
the moment the modal timer is confused with the idle countdown, which is why this is a test of its
own rather than a line in scenario 8.

**Covered by.** `tests/e2e/streak.spec.js` #2.

### 13. Cold start: what a first-time visitor lands on - _Web_

**On screen.** Storage cleared, page reloaded: the title, the hero art, one call to action.

**Underneath.** Nothing but the bundle and the first socket connect. This is the shallow guard -
it catches a build that does not boot before any of the interesting scenarios get a chance to
produce a confusing failure.

**If it were wrong.** A blank page, a missing hero image, or a "Connecting…" that never resolves -
which is exactly the trap that shipped twice, both times because the bundle had a developer socket
address baked into it (`.env.production` now pins `VITE_GAME_WS=auto`).

**Covered by.** `tests/e2e/smoke.spec.js`.

---

## Known gaps you may be asked about

- **No chart on the idle play screen.** The chart is only drawn while a round is running, by
  design (`docs/TRACKER.md` gap G5b). If somebody asks during scenario 1 or 7, that is expected.
- **Two highlighted leaderboard rows.** Gap G3, described under scenario 4. The showcase avoids
  triggering it; the product still has it until ticket B2 lands.
- **The win pane's stake number is still the client's own** (gap G2): `round_settled` does not
  carry `stake`, so the pane prints the stake for the lever it sent rather than the one the ledger
  charged. They agree today because `stake_for(lever)` is the only rule; it is a number on screen
  the server did not supply, which is why it is carded.

## Related

- `demo/redteam.mjs` and `docs/reports/redteam.md` - the same system, attacked rather than
  demonstrated.
- `demo/run-demo.mjs` - the load/acceptance runner: many windows, a fixed duration, p95 timings.
  Different job.

---

## Last full run

Thirteen of thirteen, 2026-09-16. The table below is also written to
`docs/reports/showcase-results.md` with per-scenario timestamps on every run.

```text
xChief Gold Rush - showcase
app       http://localhost:5347
socket    ws://localhost:8787/ws
database  postgresql://postgres:***@localhost:55447/postgres
started   2026-09-16T18:30:36.931Z


--- 1. A first round, decided by the server  [Web]
    PASS in 16.3s - verdict after 5052 ms ("WIN ×1 New record! +100 coins Stake 100 "); screen 1100 = server 1100

--- 2. Reload in the middle of a round  [Web]
    PASS in 10.9s - same player 9ab98d1b; rounds 1 -> 2 (exactly one)

--- 3. Signing in with an emailed code  [Web]
    PASS in 20.6s - wrong code -> "That code is not right. Try again"; code 26996528 accepted; header shows Playing as a****n@example.com · Your score and rank are save

--- 4. The leaderboard, masked and live  [Web]
    PASS in 17.3s - own row masked and highlighted (1 a****n@example.com Rookie 1,100); rival at 1877 arrived live over the socket

--- 5. Claiming a task reward  [Web]
    PASS in 29.3s - server granted 300; toast "+300 coins"; screen 1300 = server 1300

--- 6. Broke on the web is never a dead end  [Web]
    PASS in 14.3s - 50 -> 350 after the refill (free_refill_used=true); play enabled again with no reload

--- 7. The booth: attract, tap, play, verdict  [Kiosk A]
    PASS in 18.2s - verdict "MISS Not this time −100 coins Co"; session now 900 coins / streak 0; forbidden UI nodes: 0

--- 8. Five wins in a row wins the code  [Kiosk A]
    PASS in 19.0s - win modal showed XG-SHOWCASE-DEMO on 1 line; Claim returned the booth to attract (server session 'idle')

--- 9. Out of coins: the exit modal  [Kiosk B]
    PASS in 15.0s - exit modal shown from the server's broke state; Done reset the booth (server session 'idle', 1000 coins)

--- 10. Walked away: the idle countdown  [Kiosk B]
    PASS in 25.6s - overlay appeared, a mouse move cancelled it, it returned, and the flush took the booth back to attract

--- 11. The server's own idle sweep, with no client help  [Kiosk B]
    PASS in 21.5s - playing -> attract 10.0 s after the row went stale, with no client action (the sweep runs every 10 s); server session 'idle', 1000 coins, streak 0

--- 12. The winning code stays on screen long enough to photograph  [Kiosk A]
    PASS in 31.7s - the code stayed on screen untouched for 25 s, then Claim cleared the booth

--- 13. Cold start: what a first-time visitor lands on  [Web]
    PASS in 8.0s - title "xChief Gold Rush"; hero art and the start button both render on a clean first load

==============================================================================================================
SHOWCASE RESULTS
==============================================================================================================
#   WINDOW   SCENARIO                                                   RESULT  SECONDS  OBSERVATION
1   Web      A first round, decided by the server                       PASS    16.3     verdict after 5052 ms ("WIN ×1 New record! +100 coins Stake 100 "); screen 1100 = server 1100
2   Web      Reload in the middle of a round                            PASS    10.9     same player 9ab98d1b; rounds 1 -> 2 (exactly one)
3   Web      Signing in with an emailed code                            PASS    20.6     wrong code -> "That code is not right. Try again"; code 26996528 accepted; header shows Playing as a****n@example.com · Your score and rank are save
4   Web      The leaderboard, masked and live                           PASS    17.3     own row masked and highlighted (1 a****n@example.com Rookie 1,100); rival at 1877 arrived live over the socket
5   Web      Claiming a task reward                                     PASS    29.3     server granted 300; toast "+300 coins"; screen 1300 = server 1300
6   Web      Broke on the web is never a dead end                       PASS    14.3     50 -> 350 after the refill (free_refill_used=true); play enabled again with no reload
7   Kiosk A  The booth: attract, tap, play, verdict                     PASS    18.2     verdict "MISS Not this time −100 coins Co"; session now 900 coins / streak 0; forbidden UI nodes: 0
8   Kiosk A  Five wins in a row wins the code                           PASS    19.0     win modal showed XG-SHOWCASE-DEMO on 1 line; Claim returned the booth to attract (server session 'idle')
9   Kiosk B  Out of coins: the exit modal                               PASS    15.0     exit modal shown from the server's broke state; Done reset the booth (server session 'idle', 1000 coins)
10  Kiosk B  Walked away: the idle countdown                            PASS    25.6     overlay appeared, a mouse move cancelled it, it returned, and the flush took the booth back to attract
11  Kiosk B  The server's own idle sweep, with no client help           PASS    21.5     playing -> attract 10.0 s after the row went stale, with no client action (the sweep runs every 10 s); server session 'idle', 1000 coins, streak 0
12  Kiosk A  The winning code stays on screen long enough to photograph PASS    31.7     the code stayed on screen untouched for 25 s, then Claim cleared the booth
13  Web      Cold start: what a first-time visitor lands on             PASS    8.0      title "xChief Gold Rush"; hero art and the start button both render on a clean first load

Passed 13 of 13.
Written to docs\reports\showcase-results.md
```
