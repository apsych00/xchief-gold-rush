/**
 * Vercel serverless endpoint that receives leads from the app.
 *
 * Two lead types, both email only (ticket B4, docs/tasks-marketing-lead.md ground rules:
 * "Only the email identifies a web player"):
 *   type: "email"   – one-field email capture
 *   type: "signup"  – in-game xChief signup form
 *
 * Every lead is written to the function log (Vercel → project → Logs, filter
 * "[lead]"). If LEAD_WEBHOOK_URL is set, the lead is also POSTed there as
 * JSON so it can land in a Google Sheet, Zapier/Make, a CRM or a mailing
 * list. Set LEAD_WEBHOOK_SECRET to have it sent as an `X-Lead-Secret` header.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

const str = (v, max) =>
  String(v ?? '')
    .trim()
    .slice(0, max);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const body = readBody(req);
  const type = body.type === 'signup' ? 'signup' : 'email';
  const email = str(body.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }

  const lead = {
    type,
    email,
    source: str(body.source || 'unknown', 40),
    lang: str(body.lang, 5),
    balance: Number.isFinite(Number(body.balance)) ? Number(body.balance) : null,
    page: str(body.page, 200),
    ua: str(req.headers['user-agent'], 200),
    country: str(req.headers['x-vercel-ip-country'], 8),
    at: new Date().toISOString(),
  };

  console.log('[lead]', JSON.stringify(lead));

  const webhook = process.env.LEAD_WEBHOOK_URL;
  if (webhook) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (process.env.LEAD_WEBHOOK_SECRET) headers['X-Lead-Secret'] = process.env.LEAD_WEBHOOK_SECRET;
      await fetch(webhook, { method: 'POST', headers, body: JSON.stringify(lead) });
    } catch (err) {
      console.error('[lead] webhook failed', err?.message || err);
    }
  }

  return res.status(200).json({ ok: true });
}
