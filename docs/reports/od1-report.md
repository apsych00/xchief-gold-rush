# OD1: OTP 429 and the got-in-with-rewards question

Ticket: `docs/tickets/od1-otp-429.md`. Worked in the `nightmareinc/od1-otp` worktree. Nothing committed.

## Bad news first

Part 3 comes back clean - no security defect. A player cannot verify without the correct code
for their own email, and the email/signup reward cannot be released without a completed verify.
Both are proven below with integration tests, not just read from the code.

## Part 1: reproducing the owner's sequence

E2E spec: `tests/e2e/od1-otp.spec.js`. Dev recipe used (per the ticket):

```
bash db/run-tests-od1.sh --keep   # copy of db/run-tests.sh, PORT=55462, container goldrush-od1-keep
DATABASE_URL=postgresql://postgres:test@localhost:55462/postgres PORT=8803 \
  PLAYER_TOKEN_SECRET=dev-secret node server/index.js
VITE_GAME_WS=ws://localhost:8803/ws npx vite --port 5364 --strictPort
BASE_URL=http://localhost:5364 PORT=8803 npx playwright test tests/e2e/od1-otp.spec.js
```

This runs against the real server and Vite directly, outside `playwright.config.js`'s own
`webServer` entries - those neuter every S2 limit (`MAX_OTP_REQUESTS_PER_IP_PER_10MIN=1000`,
etc.) for the rest of the E2E suite, which would hide the exact bug being chased.

### What the literal sequence does, on a freshly reset per-IP budget

Request a code for one email, type 6 wrong codes, request codes for 3 more emails, one browser,
one IP. Captured console + socket sequence (from the diagnostic run against the pre-fix code):

```
[od1-ws:1] connecting to ws://localhost:5364/?token=...      (Vite's own HMR socket)
[od1-ws:1] open
[od1-ws:2] connecting to ws://localhost:8803/ws              (the game socket)
[od1-ws:2] open
[wrong-code:1] modal error text: That code is not right. Try again
[wrong-code:2] modal error text: That code is not right. Try again
[wrong-code:3] modal error text: That code is not right. Try again
[wrong-code:4] modal error text: That code is not right. Try again
[wrong-code:5] modal error text: Too many tries. Send a new code       (S13: 5th attempt locks the code)
[wrong-code:6] modal error text: That code expired. Send a new one     (the locked code's used_at is set; the 6th guess finds no live row)
[extra-email:1] -> code-step   (2nd request_otp on this IP)
[extra-email:2] -> code-step   (3rd request_otp on this IP)
[extra-email:3] -> code-step   (4th request_otp on this IP)
[sockets] [{"id":1,...,"closeCode":null},{"id":2,...,"closeCode":null}]
has429=false socketClosed=false socketCount=2
```

**No 429, no socket close, no reconnect.** Four `request_otp` calls total on one IP never came
close to the (then-)default `MAX_OTP_REQUESTS_PER_IP_PER_10MIN=5`, and the game socket never
closed - `invalid_code`/`too_many_attempts` errors already never close or reconnect it (checked
directly against `server/index.js`'s `verify_otp` handler: no `ws.close()` on either branch, and
`src/api/session.js`/`src/Identity.jsx` never react to a rejected `verifyOtp()` by touching the
socket).

### Isolating what a literal "429" in the console actually is

The WebSocket spec does not expose the HTTP status of a failed handshake to JS - `onclose`/
`onerror` carry no code for it. So the literal text "429" the owner described can only come from
one place: Chrome's own console line for a rejected WS upgrade. Confirmed directly by opening 32
raw WebSockets against the game server from a page context:

```
RESULTS: [ "open" x29, "error" x3 ]
CONSOLE_LINES:
[error] WebSocket connection to 'ws://localhost:8803/ws' failed: Error during WebSocket handshake: Unexpected response code: 429
(repeated 3x)
```

This is `server/index.js`'s `upgrade` handler (`server/limits.js`'s `checkNewConnection`,
`MAX_CONNECTIONS_PER_IP_PER_MIN`) - the raw `HTTP/1.1 429` response written before the WebSocket
handshake ever completes. It is the *only* mechanism that produces this literal string in a
browser console; the OTP-specific refusals (`checkOtpIp`/`checkOtpEmail`) are ordinary WS `error`
frames over an already-open socket and show as `Error: rate_limited`, never "429".

**Conclusion: the exact 429 source is the per-IP WS-upgrade connection window
(`MAX_CONNECTIONS_PER_IP_PER_MIN`), not the OTP request/verify frames.** A single visitor
running through exactly what the owner described, on a freshly reset budget, does not reach it.
The realistic trigger is many connection attempts landing on one IP inside a minute - most
plausibly a shared venue IP (the tracker already carries "production numbers under review with
the owner (venue NAT)" against S2), or a client stuck in a fast reconnect loop from something
else entirely (a dev-server restart, several tabs, etc.). Given that, Part 2's fix targets two
things: raising the OTP-specific budgets so a legitimate flurry of requests behind a shared IP
never becomes the reason a real 429 gets provoked sooner, and making the 429 itself, whenever it
does happen, show something other than a silent-to-the-player console line.

## Part 2: the fix

1. **`server/limits.js`** - `MAX_OTP_REQUESTS_PER_IP_PER_10MIN` 5 → 30, `MAX_OTP_REQUESTS_PER_EMAIL_PER_10MIN` 3 → 5 (both env-overridable, unchanged shape). `MAX_CONNECTIONS_PER_IP_PER_MIN` (30) and `MAX_SOCKETS_PER_IP` (20) were already at their ticket-approved values and untouched.
2. **The 5-attempts-per-code rule (S13) is untouched** and still shows the existing copy - verified word for word in the E2E spec: 4× "That code is not right. Try again", then "Too many tries. Send a new code" on the 5th, "That code expired. Send a new one" on the 6th (the code's `used_at` is now set).
3. **`invalid_code`/`too_many_attempts` never close or reconnect the socket** - this was already true; locked in with an integration assertion (`test/integration-box/otp.test.mjs`: `get_me` still answers on the same socket right after a wrong guess) and an E2E assertion (the game socket's close code stays `null` across all 9 OTP attempts in the regression spec).
4. **The 429-on-upgrade path now shows something other than a silent console line.** Since the browser cannot read the failed handshake's status, `src/api/socket.js` tracks the only client-visible signature it has: two consecutive reconnect attempts that never reach `onopen` set a `connectionRefused` flag (same shape as the existing `kioskUnauthorized` signal). `src/priceFeed.js` carries it through to `feed.connectionRefused`; `src/App.jsx` shows a line under the existing `FeedBadge` (reusing the `.lead-error` colour token, no new colours) reading:
   - en: "Too many connections from this network, try again in a minute"
   - fa: "اتصال زیاده از این شبکه؛ یک دقیقه دیگه دوباره امتحان کن"

## Part 3: the "got in with rewards" question

**Can a player verify without a correct code?** No. `verify_otp_code` (`db/schema.sql`) selects
its row `where player_id = p_player and email = p_email and used_at is null and expires_at >
now()` - a code is only ever checked against the exact player and email it was minted for. Proved
directly with a new integration test: a second, unrelated player who never requested a code for
an email gets `expired_code` even when handed the *real, correct* code for that email - there is
no row for their own `(player_id, email)` pair to match against, so no cross-player guessing path
exists.

**Can the email or signup reward be released without a completed verify?** No.
`ledger.verifyOtpCode` (`server/ledger.js`) throws for every outcome except `'ok'` and
`'logged_in:<uuid>'` - `invalid_code` and `too_many_attempts` both throw, which sends execution
straight to `handleFrame`'s outer `catch` in `server/index.js` and never reaches the
`releaseTaskReward(id, 'email'/'signup')` calls at all; those only run in the success branch.
Proved directly with a new integration test: after a wrong guess, both `players.email` and
`task_claims` for that player are confirmed untouched.

**How did the owner's later emails actually get verified on the local stack?** The dev path,
not a bypass. `server/otp.js`'s `send()`: without `ELASTIC_API_KEY` set (the local compose
stack's default), the plain code is never mailed - it is written to `public.dev_otps` and logged
to the server's own stdout as `dev otp captured for <email>: <code>`. Either the docker compose
logs (visible to anyone running `docker compose logs -f server`) or `npm run otp:peek --
<email>` (`scripts/peek-otp.mjs`, reading `public.dev_otps`) hands back the real code for any
email that has requested one. The owner, testing locally, had a legitimate way to read the real
code for their next test email - not a security hole, and not the same channel a real visitor at
the booth or on the live site would ever have (production always sets `ELASTIC_API_KEY`, and
`public.dev_otps` sits behind `revoke all ... from public, anon, authenticated` in
`db/schema.sql`, unreadable to any client either way).

## Judgement calls

- Browsers cannot read the HTTP status of a failed WS handshake (a platform limitation, not a
  bug) - `connectionRefused` is a heuristic (two consecutive handshake failures in a row), not a
  literal "this was specifically a 429" detection. It is the same shape and confidence level as
  the existing `kioskUnauthorized` signal already relies on for the kiosk's own reconnect state.
- The new copy sits as a small line under the existing `FeedBadge`, not a full-screen overlay -
  the web player has no dedicated reconnect overlay to reuse (only the kiosk does); a new overlay
  component would be new UI beyond what this ticket asks for.
- `public.leaderboard()`'s `rank() over (order by ts.record desc, ts.updated_at asc)` can tie two
  rows with identical rank if `record` and `updated_at` match to the microsecond - surfaced as a
  React key-collision console warning during heavy automated test churn on the throwaway DB. In
  real play this needs two distinct players settling at the literal same microsecond, which is
  why it is flagged here rather than fixed under this ticket - genuine but exceedingly unlikely,
  and a schema change is outside OD1's scope. Worth a scope-creep card if the owner wants it
  closed.
- `npm run db:test`'s default port 55432 collided with an already-running `goldrush-box-keep`
  container from elsewhere in this environment; left untouched (not mine to remove) and pgTAP was
  instead verified green through the OD1 harness's own throwaway container (port 55462), same
  `db/schema.sql`.
- Two small things fixed on the way, in files already touched, unrelated to OD1's core ask: a
  stale `no-console` eslint-disable in the new spec, and two OTP unit test names in
  `test/unit/limits.test.mjs` that hardcoded the old 5/3 defaults in their title strings (now
  interpolate `LIMITS.*`, matching how the integration suite already names these tests).
- Did not capture a screenshot of the new "too many connections" line beside an existing screen
  (design-fidelity rule) - reproducing it needs two real handshake failures against a live
  instance, and the OD1 harness (server, Vite, DB container) was already torn down by the time
  this was caught. Open item; flagged rather than silently skipped.

## Files touched

- `server/limits.js` - OTP budgets raised (decision 2 above)
- `src/api/socket.js` - `connectionRefused` signature
- `src/priceFeed.js` - carries `connectionRefused` through to the feed status object
- `src/useGame.js` - `feed` initial shape includes `connectionRefused`
- `src/App.jsx` - renders the new line under `FeedBadge`
- `src/i18n.js` - `feed.tooManyConnections` in both languages
- `src/styles.css` - `.feed-refused` (position/sizing only, no new colours)
- `test/integration-box/otp.test.mjs` - two new tests (Part 3 proofs above)
- `test/unit/limits.test.mjs` - two test names corrected to the new defaults
- `test/integration-box/leaderboard.test.mjs` - one stale comment corrected
- `tests/e2e/od1-otp.spec.js` - new regression spec (Part 1's repro, turned into the permanent
  regression: no 429, exact copy at each step, socket never closes, a fresh email still works)

Nothing committed. `db/run-tests-od1.sh` (the throwaway harness copy) and the `goldrush-od1-keep`
container were deleted after use, per the ticket.

## Gate outputs (all run in the foreground, unpiped, exit codes read)

| Gate | Result |
|---|---|
| `npm run lint` | clean, 0 errors, 0 warnings |
| `npm run test:unit` | 137 pass, 0 fail |
| `npm test` (economy) | 7 pass, 0 fail |
| pgTAP (OD1 harness, port 55462) | 285 pass, 0 fail |
| `npm run test:server` (full `test/integration-box/*.test.mjs`) | 87 pass, 0 fail |
| `npm run build` | succeeds |
| Full E2E suite (`npx playwright test`, `VITE_GAME_WS` on the command line) | 31/31 pass |

One transient E2E failure along the way is worth recording for the next person who reruns this:
`instagram.spec.js` timed out on a second consecutive full-suite run against the same reused
fixtures (its fake-OAuth account was already `already_claimed` from the first run) - a test
isolation artifact of running the whole suite twice in a row against one persistent throwaway DB,
not a regression. It passed clean on the run before that, and on the run this report's numbers
are drawn from.
