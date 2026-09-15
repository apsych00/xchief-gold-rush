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

## 3. Two dashboard settings (the only manual part)

In the new project's dashboard:
- **Authentication -> URL Configuration:** Site URL + Redirect URL = the Vercel production URL.
- **Authentication -> Hooks -> Send Email:** enable, endpoint = the deployed `otp-email` function URL, generate the secret, set it on the function (`SEND_EMAIL_HOOK_SECRET`).

## 4. Vercel

Set the same `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_RELAY_URL` in the Vercel project's environment variables and redeploy.
