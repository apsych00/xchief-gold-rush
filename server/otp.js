/**
 * Login codes on the box (docs/box-plan.md 1.5, docs/box-spec.md 1.5): the code itself is
 * generated and hashed in db/migrations/0011_otp_codes.sql (request_otp_code); this module only
 * gets the plain code to the player. Same Elastic form-encoded POST the Supabase Auth hook used
 * (supabase/functions/otp-email/index.ts). Without ELASTIC_API_KEY (dev) the code is captured in
 * public.dev_otps instead of being sent - the plain code is never logged either way.
 */

import * as ledger from './ledger.js';

const ELASTIC_SEND_URL = 'https://api.elasticemail.com/v2/email/send';

export async function send(email, code) {
  const apiKey = process.env.ELASTIC_API_KEY;
  if (!apiKey) {
    await ledger.insertDevOtp(email, code);
    console.log(`dev otp captured for ${email}`);
    return;
  }

  const form = new URLSearchParams({
    apikey: apiKey,
    to: email,
    from: process.env.OTP_SENDER || '',
    fromName: 'xChief Gold Rush',
    subject: `Your xChief Gold Rush code: ${code}`,
    template: 'gold_rush_otp',
    merge_otp_code: code,
    isTransactional: 'true',
  });

  const res = await fetch(ELASTIC_SEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  let result;
  try {
    result = await res.json();
  } catch {
    throw new Error('elastic_email_bad_response');
  }
  if (!res.ok || result.success === false) {
    throw new Error(result.error || 'elastic_email_send_failed');
  }
}

/**
 * The $100 bonus code, once a /claim/<token> visitor's email has actually claimed it (ticket
 * C9, docs/tickets/c9-qr-claim.md decision 4): a plain-text body, not the OTP's merge-field
 * template - there is no template built for this in Elastic. Without ELASTIC_API_KEY (dev) the
 * code is just logged, same shape as send()'s own dev fallback; the caller (server/index.js)
 * already logs and swallows any failure here itself - a mail failure never undoes a claim that
 * already committed in Postgres.
 */
export async function sendClaimCode(email, code) {
  const apiKey = process.env.ELASTIC_API_KEY;
  const body = `Congratulations! Your xChief $100 bonus code is: ${code}\n\nScreenshot this email or the gift card on screen to redeem it at the xChief booth.`;
  if (!apiKey) {
    console.log(`dev claim code captured for ${email}: ${code}`);
    return;
  }

  const form = new URLSearchParams({
    apikey: apiKey,
    to: email,
    from: process.env.OTP_SENDER || '',
    fromName: 'xChief Gold Rush',
    subject: 'Your xChief $100 bonus code',
    bodyText: body,
    isTransactional: 'true',
  });

  const res = await fetch(ELASTIC_SEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  let result;
  try {
    result = await res.json();
  } catch {
    throw new Error('elastic_email_bad_response');
  }
  if (!res.ok || result.success === false) {
    throw new Error(result.error || 'elastic_email_send_failed');
  }
}
