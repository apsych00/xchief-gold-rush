# Switching Supabase projects (dev -> production)

Nothing about the backend is tied to a specific Supabase project. Everything is code in `supabase/` and is pointed at a project only through `.env`. Re-pointing takes about two minutes.

## 1. Swap the five values in `.env`

```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
SUPABASE_PROJECT_REF=
SUPABASE_DB_PASSWORD=
SUPABASE_ACCESS_TOKEN=
```

## 2. Re-link and push (I run these)

```
npx supabase link --project-ref <ref>
npx supabase db push                       # schema, RLS, functions
npx supabase functions deploy              # edge functions
npx supabase secrets set --env-file .env   # ELASTIC_API_KEY, OTP_SENDER, RELAY_PRICE_URL
```

Then load the real coupon codes and kiosk with the seed script.

## Login codes without an email provider (dev)

When the `otp-email` function has no `ELASTIC_API_KEY`, it stores each code in `public.dev_otps` (service-role only) instead of sending mail. Read the newest code for an address with `npm run otp:peek -- <email>` (needs `SUPABASE_PROJECT_REF` + `SUPABASE_ACCESS_TOKEN` in the environment). Production always has the key set, so the table stays empty there. The dev project's hook is already enabled with a signing secret; the same two settings are done on production in step 3.

## 3. Two dashboard settings (the only manual part)

In the new project's dashboard:
- **Authentication -> URL Configuration:** Site URL + Redirect URL = the Vercel production URL.
- **Authentication -> Hooks -> Send Email:** enable, endpoint = the deployed `otp-email` function URL, generate the secret, set it on the function (`SEND_EMAIL_HOOK_SECRET`).

## 4. Vercel

Set the same `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_RELAY_URL` in the Vercel project's environment variables and redeploy.

## Auth rate limits (set on production)

Supabase's default auth email limit is far below campaign volume and returns `429 email rate limit exceeded` when hit. Set on the production project (Authentication -> Rate Limits, or the Management API `config/auth`): `rate_limit_email_sent` = 500 per hour (2,000 logins/day peaks well above the hourly average), `rate_limit_verify` = 1000, `rate_limit_anonymous_users` = 500 per hour. Dev is set to 200/300.
