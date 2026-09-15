# Journeys and architecture

Reflects the locked decisions: server decides every outcome, Supabase owns the ledger, each round is one held-open Supabase call, relay stays a dumb price feed, leaderboard ranks peak balance.

## 1. Web journey (play first, email later to rank)

```mermaid
flowchart TD
  A[Open web app on Vercel] --> B[Anonymous session in Supabase]
  B --> C[Play 5s rounds - server decides win or lose]
  C --> D{Milestone hit? first win or trader level}
  D -- no --> C
  D -- yes --> E[Prompt for email]
  E --> F[Supabase issues OTP, Elastic sends branded email]
  F --> G[Enter code, verified]
  G --> H[Anonymous upgraded to email account, score kept]
  H --> I[Now on Top 10 leaderboard by peak score]
  I --> C
  C --> J{Campaign ends}
  J --> K[Top 3 by peak score emailed for prizes]
```

## 2. Kiosk journey (ephemeral, no email, coupon on 5 in a row)

```mermaid
flowchart TD
  A[Kiosk opens fixed launch URL with embedded secret] --> B[Player plays 5s rounds - server decides]
  B --> C{Win?}
  C -- yes --> D[Server increments this kiosk streak]
  C -- no --> E[Streak resets to 0]
  E --> B
  D --> F{Streak = 5?}
  F -- no --> B
  F -- yes --> G[Server atomically claims one coupon]
  G --> H[Show 100 dollar code once, streak resets]
  H --> I[Next player starts fresh]
  I --> B
```

## 3. What talks to what

```mermaid
flowchart LR
  W[Web browser]
  K[Kiosk browser]
  V[Vercel frontend]
  AU[Supabase Auth and OTP]
  FN[Supabase Edge Functions]
  DB[(Supabase Postgres and RLS)]
  R[Fly.io relay]
  EM[Elastic Mail API]
  UP[Finnhub OKX Binance]

  W -->|load app| V
  K -->|load app| V
  W -->|live prices over WS| R
  K -->|live prices over WS| R
  W -->|play round, claim task| FN
  K -->|play round| FN
  W -->|request OTP| AU
  FN -->|read current price| R
  FN --> DB
  AU -->|send-email hook| FN
  FN -->|OTP via template| EM
  EM -->|delivers to inbox| W
  R -->|subscribes to| UP
```

## 4. Who owns which domain and who must know it

```mermaid
flowchart TD
  DNS[xChief domain owner controls DNS] --> M[goldrush.xchief.academy to Elastic: SPF DKIM DMARC]
  DNS --> AP[app domain to Vercel: CNAME]
  DNS --> RL[relay domain to Fly: optional CNAME]
  M --> E[Elastic sends OTP from noreply at goldrush.xchief.academy]
  AP --> V[Vercel serves the game]
  RL --> R[Fly serves live prices]
  V -.app URL must be set in.-> SUP[Supabase Auth site and redirect URL]
  R -.relay URL and Supabase URL go into.-> CE[Client env on Vercel]
```

## 5. Dev and deploy flow

```mermaid
flowchart LR
  WK[Workers in Orca worktrees] -->|branch + PR| GH[GitHub: AIT-ERP/xChief-Gold-Rush]
  ME[Me: review and merge] --> GH
  GH -->|CI runs tests| CI[GitHub Actions]
  GH -->|deploy main| VC[Vercel production]
  GH -->|deploy PR| PV[Vercel preview]
  REL[relay directory] -->|fly deploy| FLY[Fly.io relay]
  SUP[supabase directory] -->|db push and functions deploy| SB[Supabase]
```

## Open decision

- Web journey branch: **play-first** (anonymous session, prompt email at a milestone - drawn above, my recommendation) vs **email-gate** (must verify email before the first round). Confirm which.
