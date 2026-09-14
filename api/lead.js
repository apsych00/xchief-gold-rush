/**
 * Vercel serverless endpoint that receives email leads from the app.
 *
 * Every lead is written to the function log (visible under the project's
 * Logs tab on Vercel). If LEAD_WEBHOOK_URL is set in the project's
 * environment variables, the lead is also POSTed there as JSON so it can land
 * in a Google Sheet, Zapier/Make, a CRM, or a mailing-list tool.
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const body = readBody(req);
  const email = String(body.email || '')
    .trim()
    .toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }

  const lead = {
    email,
    source: String(body.source || 'unknown').slice(0, 40),
    lang: String(body.lang || '').slice(0, 5),
    balance: Number.isFinite(Number(body.balance)) ? Number(body.balance) : null,
    page: String(body.page || '').slice(0, 200),
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
    country: String(req.headers['x-vercel-ip-country'] || ''),
    at: new Date().toISOString(),
  };

  console.log('[lead]', JSON.stringify(lead));

  const webhook = process.env.LEAD_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lead),
      });
    } catch (err) {
      console.error('[lead] webhook failed', err?.message || err);
    }
  }

  return res.status(200).json({ ok: true });
}
