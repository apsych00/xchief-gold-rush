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
