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
- `{unsubscribe}` - Elastic Mail's own built-in unsubscribe field, not one we fill in

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

## What we need back

Once the template is created, send us the **template id** Elastic Mail assigns it. That is the
only thing the server needs; everything else (subject, merge fields, sender) is already wired on
our side.

## Outbound links in this template

Every link points at either `xchief.com` / `my.xchief.com` or the game's own
`goldrush.xchief.academy`. The footer's "Play Gold Rush" link used to point at the old
`xchief-gold-rush.vercel.app` preview host and now points at `https://goldrush.xchief.academy`
(owner's call, 2026-09-19). If a future edit introduces a link to any other host, raise it with
the owner rather than shipping it.
