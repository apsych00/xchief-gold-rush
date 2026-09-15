# Edge Functions

## `play-round`

Web mode round. Verifies the caller's JWT, reads the relay price, opens a
round, holds the connection for the server-owned 5-second clock, reads the
price again, and settles. The client never asserts its own outcome.

Env: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (all
auto-injected by the Supabase runtime), `RELAY_PRICE_URL`.

## `play-round-kiosk`

Same round mechanics as `play-round`, but identity comes from a bearer
`secret` instead of a JWT. Coins/levers are cosmetic; the kiosk cares about
the win streak and the coupon it releases at 5 wins.

Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (auto-injected),
`RELAY_PRICE_URL`.

## `otp-email`

Supabase Auth "Send Email" hook. Verifies the webhook signature, then sends
the OTP through Elastic Mail. Never logs the token.

Env: `SEND_EMAIL_HOOK_SECRET` (optional locally - verification is skipped
with a warning if unset), `ELASTIC_API_KEY`, `OTP_SENDER`.

## `_shared`

Common helpers (`mod.ts`): CORS headers, `readRelayPrice`, `serviceClient`,
`anonClient`, `jsonResponse`, `sleep`. Not a deployable function on its own.

## Local serve

```
npx supabase functions serve --env-file .env --no-verify-jwt
```

## Local curl examples

```
# play-round (needs a real user JWT from Supabase Auth)
curl -i -X POST http://127.0.0.1:54321/functions/v1/play-round \
  -H "Authorization: Bearer <user-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"dir":"up","lever":1}'

# play-round-kiosk (needs a real kiosk secret from the kiosks table)
curl -i -X POST http://127.0.0.1:54321/functions/v1/play-round-kiosk \
  -H "Content-Type: application/json" \
  -d '{"secret":"<kiosk-secret>","dir":"down"}'

# otp-email (as Supabase Auth would call it - signature verification is
# skipped when SEND_EMAIL_HOOK_SECRET is unset in the local env)
curl -i -X POST http://127.0.0.1:54321/functions/v1/otp-email \
  -H "Content-Type: application/json" \
  -d '{"user":{"email":"test@example.com"},"email_data":{"token":"123456"}}'
```
