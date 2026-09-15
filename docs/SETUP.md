# Setup - your only job

Open **`.env`** in the project root and paste in the values below. That's the whole task. I do all the code, deploy, and testing.

## 1. Supabase - go to supabase.com
Create a project (any name; **save the database password**; region Frankfurt). Then grab:

| Get it from | Paste into `.env` |
|---|---|
| Settings -> API -> **Project URL** | `VITE_SUPABASE_URL` |
| Settings -> API -> **anon public** key | `VITE_SUPABASE_ANON_KEY` |
| Settings -> General -> **Reference ID** | `SUPABASE_PROJECT_REF` |
| the **database password** you chose | `SUPABASE_DB_PASSWORD` |
| Account menu -> **Access Tokens** -> Generate | `SUPABASE_ACCESS_TOKEN` |

## 2. Elastic Mail - your Elastic dashboard

| Get it from | Paste into `.env` |
|---|---|
| your **API key** | `ELASTIC_API_KEY` |
| your **sender address** (e.g. no-reply@goldrush.xchief.academy) | `OTP_SENDER` |

## 3. Relay
Leave `VITE_RELAY_URL` blank. I handle the price feed for dev.

---

Save `.env`, then tell me **"keys in"**. I take it from there.

You do **not** need to install anything. Not the Supabase CLI, not Docker configs, nothing. Just the keys.
