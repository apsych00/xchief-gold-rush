# Ticket B8: Instagram follow reward - delivery report

Branch: `nightmareinc/b8-instagram`
Date: 2026-09-17

## What was built

A server-verified Instagram reward that grants the seeded `instagram` task once per Instagram `user_id`:

- `db/schema.sql` - added `public.instagram_accounts` (PK on `ig_user_id`, `username`, `player_id`, `device_id`, `verified_at`) with RLS/grants.
- `server/instagram.js` - adapter for Instagram OAuth/Graph endpoints, overridable via `INSTAGRAM_API_BASE`.
- `server/ledger.js` - `storeInstagramAccount`, `findInstagramAccount`, `getPlayerDeviceId`.
- `server/index.js` - HMAC-signed state helpers, `GET /api/instagram/start`, `GET /api/instagram/callback`, and an `instagram` field on `/status`.
- `src/Tasks.jsx` - Instagram task UI, status banner, and refresh on successful return (`?ig=done`).
- `src/styles.css` - banner styles for done/pending/coming-soon states.
- `src/i18n.js` - `instagramPending`, `instagramDone`, `instagramFailed`, `instagramComingSoon` copy in `en` and `fa`.
- `.env.box.example` - documented `INSTAGRAM_*` variables.
- `docs/box-deploy.md` - added the "Instagram follow reward (ticket B8)" section, including the limitation (no follow API exists) and the exact credentials-arrived checklist.
- `test/fakes/instagram.mjs` - fake Instagram OAuth/Graph server.
- `test/unit/instagram.test.mjs` - state HMAC, adapter success/error, `not_configured` cases.
- `test/integration-box/instagram.test.mjs` - happy path, duplicate `ig_user_id` refusal, missing-env `not_configured`.
- `db/tests/86_instagram.sql` - pgTAP coverage for the new table and the server-side `release_task_reward('instagram')` path.
- `playwright.config.js` - fake Instagram webServer, Instagram env vars for the game server, and `VITE_GAME_WS` for Vite.
- `tests/e2e/instagram.spec.js` - end-to-end fake-OAuth flow verifying `?ig=done`, a claimed row, and a credited reward.
- `vite.config.js` - dev proxy for `/api` to the game server so client-side `/api/*` fetches work when Vite and the server run on different ports.

## Gate results

| Gate               | Command                                                                                | Result            |
| ------------------ | -------------------------------------------------------------------------------------- | ----------------- |
| Lint               | `npm run lint`                                                                         | pass              |
| Economy unit       | `npm test`                                                                             | pass (7/7)        |
| Unit               | `npm run test:unit`                                                                    | pass (135/135)    |
| Database           | `npm run db:test -- --keep`                                                            | pass (285/285)    |
| Server integration | `DATABASE_URL=postgresql://postgres:test@localhost:55432/postgres npm run test:server` | pass (85/85)      |
| Build              | `npm run build`                                                                        | pass, no warnings |
| E2E                | `npx playwright test tests/e2e/instagram.spec.js`                                      | pass (1/1)        |

## Notes

- The reward proves the player completed Instagram Login, not that they clicked Follow. Instagram does not expose a "does user X follow account Y" endpoint to third parties. The actual follow is requested after OAuth via `INSTAGRAM_PROFILE_URL`; the same lenient redirect-and-return model as ticket B7 applies, with hardening planned in ticket B13.
- `/api/instagram/start` returns `?ig=not_configured` until `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, and `INSTAGRAM_REDIRECT_URI` are set.
- Two simultaneous claims cannot take the same `ig_user_id` because the insert into `public.instagram_accounts` is protected by its primary key.
- The feature is built and tested; it will switch on automatically once the real Instagram credentials are added and the server is restarted.
