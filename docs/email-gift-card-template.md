# Gift-card email: what to send the Elastic Mail admin

## The file

`xChief Gold Rush Gift Email.html` in the repo root is a standalone, sendable HTML email - not a
design-tool export anymore. It is the $100 gift-card email a kiosk visitor gets after claiming
their prize at `/claim/<token>` (ticket C9). Hand this file to the Elastic Mail admin as-is and
ask them to create a new template from it in the Elastic Mail dashboard (Templates -> New
template -> paste/upload the HTML).

## What the template needs to work

Four placeholders in the HTML must stay exactly as written - the server fills them in on every
send through Elastic's merge-field substitution:

- `{code}` - the gift-card code
- `{expires_at}` - a human-readable date, e.g. "October 19, 2026"
- `{claim_url}` - the claim page link (fallback in case the main button does not work in some
  client)

There is deliberately **no `{unsubscribe}`** in the footer. This is a transactional send - one
gift card to the one person who just asked for it - and the server sends it with
`isTransactional=true`, so Elastic neither requires nor injects an opt-out link.

The email also loads four assets over `https://` from `goldrush.xchief.academy/email/`: the
xChief logo PNG and three Space Grotesk woff2 files. Those already live in this repo under
`public/` and ship with every deploy, so no separate upload is needed for them - they just need
the site to be live at that domain by the time the template sends its first real email.

## Where the images should live (recommended change)

Right now the logo and the three font files are served from our own site
(`https://goldrush.xchief.academy/email/...`) because they ship inside the app's `public/`
directory. That works, but it couples a sent email to our deployments, and an email is a
document that outlives them: this one advertises a 30-day redemption window, so a recipient may
well open it weeks after we next reorganise the site. If that path ever moves, the logo silently
breaks in an inbox we cannot reach.

**The better arrangement: upload the logo into Elastic Mail's own file manager and point the
template at the URL it returns.** The admin is already in the dashboard creating the template,
so it costs nothing extra, and it makes the template self-contained - our deploys can no longer
break it. The copies under `public/email/` then serve only as the fallback and the source of
truth for the artwork.

**On the fonts, the honest answer is that they barely matter.** Gmail, Outlook and Yahoo all
ignore `@font-face` in email, so the large majority of recipients see the fallback stack
regardless - which we rendered and checked, and it looks correct. Keep them as progressive
enhancement for the clients that do honour them (Apple Mail), or drop them; either is fine.

One thing not to do: never inline images as base64 data URIs. Gmail strips them, and the email
arrives with holes where the artwork should be.

## What came back (2026-09-20)

The template is live in Elastic Mail as **`gold-rush-gift`**, with the three merge fields wired
to the lines they fill:

| Field          | Line | What it fills                           |
| -------------- | ---- | --------------------------------------- |
| `{code}`       | 85   | the gift-card code in the gold panel     |
| `{expires_at}` | 90   | the expiry line under the code           |
| `{claim_url}`  | 124  | the "Button not working?" fallback link  |

That name is what the server sends as the template, so `ELASTIC_CLAIM_TEMPLATE_ID=gold-rush-gift`
is the whole configuration change.

## Two things still to clear with the admin

The first test send came back with two pieces of chrome nobody asked for.

**An unsubscribe link in the footer.** That one was ours: the template file still carried an
`{unsubscribe}` merge field on its last footer line, so Elastic filled it in. It has been
removed from the file here, and the admin needs to remove that same line from the template they
already created (or re-import the file).

**A washed-out xChief logo on a white strip below the email.** That one is not in this file at
all - it sits outside the dark 600px wrapper, which is the giveaway. Elastic appends it at the
account level, so it goes on every send from the account regardless of template. The admin turns
it off in the Elastic dashboard's account/branding settings; there is nothing we can do about it
from the HTML.

One thing the template alone does not cover: `{claim_url}` is built as
`<PUBLIC_URL>/claim/<token>`, so the environment also needs `PUBLIC_URL` set to the site's own
origin (`https://goldrush.xchief.academy` on the box, no trailing slash). It was never in
`.env.box.example` and is not set on the box today, so it has to be added there before the first
real send - without it the fallback link arrives empty, and the kiosk's own WON-screen QR cannot
be built either.

## Outbound links in this template

Every link points at either `xchief.com` / `my.xchief.com` or the game's own
`goldrush.xchief.academy`. The footer's "Play Gold Rush" link used to point at the old
`xchief-gold-rush.vercel.app` preview host and now points at `https://goldrush.xchief.academy`
(owner's call, 2026-09-19). If a future edit introduces a link to any other host, raise it with
the owner rather than shipping it.
