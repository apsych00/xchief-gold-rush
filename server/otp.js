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

// Where the gift-card code is actually redeemed: the same destination as the template's own
// Redeem button, so the fallback link under it cannot lead somewhere different.
const REDEEM_URL = 'https://my.xchief.com/bonuses-credits/promo?lang=en';

// The gift card's own copy ("Valid for 30 days from today") - claim_prize (db/schema.sql)
// stamps claimed_at but nothing tracks a separate redemption deadline in Postgres, so "today"
// is the moment this send runs, right after the claim committed.
const CLAIM_CODE_VALID_MS = 30 * 24 * 60 * 60 * 1000;

function formatExpiry(date) {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/**
 * The $100 bonus code, once a /claim/<token> visitor's email has actually claimed it (ticket
 * C9, docs/tickets/c9-qr-claim.md decision 4). Without ELASTIC_API_KEY (dev) the code is just
 * logged, same shape as send()'s own dev fallback; the caller (server/index.js) already logs
 * and swallows any failure here itself - a mail failure never undoes a claim that already
 * committed in Postgres.
 *
 * With ELASTIC_CLAIM_TEMPLATE_ID set, this sends through that Elastic Mail template (the
 * decoded "xChief Gold Rush Gift Email.html", docs/email-gift-card-template.md) with
 * merge_code/merge_expires_at/merge_claim_url filling its {code}/{expires_at}/{claim_url}
 * placeholders - the owner only has to hand over the id once the template exists there. Until
 * then this falls back to the original plain-text body, so dev keeps working unchanged.
 */
export async function sendClaimCode(email, code) {
  const apiKey = process.env.ELASTIC_API_KEY;
  if (!apiKey) {
    console.log(`dev claim code captured for ${email}: ${code}`);
    return;
  }

  const templateId = process.env.ELASTIC_CLAIM_TEMPLATE_ID;
  const form = new URLSearchParams({
    apikey: apiKey,
    to: email,
    from: process.env.OTP_SENDER || '',
    fromName: 'xChief Gold Rush',
    isTransactional: 'true',
  });

  if (templateId) {
    const expiresAt = formatExpiry(new Date(Date.now() + CLAIM_CODE_VALID_MS));
    form.set('template', templateId);
    form.set('subject', 'Your xChief $100 gift card code');
    form.set('merge_code', code);
    form.set('merge_expires_at', expiresAt);
    // The template's "Button not working?" line is a fallback for the Redeem button above it, so
    // it has to lead to the same place - the client area's promo page, where the code is actually
    // entered. It used to receive this send's own /claim/<token> link, which is where the visitor
    // typed their email to get the code in the first place: by the time they are reading this,
    // that page has done its job and sends them nowhere useful.
    //
    // Fixed here rather than in the HTML because the template already lives in Elastic Mail and
    // cannot be edited right now. The placeholder is still called {claim_url} there; only the
    // value we fill it with has changed.
    form.set('merge_claim_url', REDEEM_URL);
  } else {
    form.set('subject', 'Your xChief $100 bonus code');
    form.set(
      'bodyText',
      `Congratulations! Your xChief $100 bonus code is: ${code}\n\nScreenshot this email or the gift card on screen to redeem it at the xChief booth.`,
    );
  }

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
