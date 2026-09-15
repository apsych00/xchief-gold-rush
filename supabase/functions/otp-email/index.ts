// Supabase Auth "Send Email" hook. Verifies the webhook signature, then hands
// the OTP to Elastic Mail. Never logs the token.
import { Webhook } from "npm:standardwebhooks@1";
import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse } from "../_shared/mod.ts";

const SEND_EMAIL_HOOK_SECRET = Deno.env.get("SEND_EMAIL_HOOK_SECRET") ?? "";
const ELASTIC_API_KEY = Deno.env.get("ELASTIC_API_KEY") ?? "";
const OTP_SENDER = Deno.env.get("OTP_SENDER") ?? "";

interface HookPayload {
  user: { email?: string; new_email?: string };
  email_data: { token?: string; token_new?: string; new_email?: string; email_action_type?: string };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  const rawBody = await req.text();

  if (SEND_EMAIL_HOOK_SECRET) {
    // Supabase prefixes the secret as "v1,whsec_<base64>"; the Webhook class
    // expects the "whsec_<base64>" form and does the base64 decode itself.
    const secret = SEND_EMAIL_HOOK_SECRET.replace(/^v1,/, "");
    const wh = new Webhook(secret);
    try {
      wh.verify(rawBody, {
        "webhook-id": req.headers.get("webhook-id") ?? "",
        "webhook-timestamp": req.headers.get("webhook-timestamp") ?? "",
        "webhook-signature": req.headers.get("webhook-signature") ?? "",
      });
    } catch {
      return jsonResponse(401, { error: "invalid_signature" });
    }
  } else {
    console.warn("[otp-email] SEND_EMAIL_HOOK_SECRET not set, skipping signature verification");
  }

  let payload: HookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { error: "bad_request" });
  }

  // An email change (an anonymous player linking an address) carries the code for the NEW
  // address as token_new and the address itself as new_email; a plain login uses token/email.
  const ed = (payload?.email_data ?? {}) as Record<string, string | undefined>;
  const email = ed.new_email || payload?.user?.email || (payload?.user as Record<string, string | undefined>)?.new_email;
  const token = ed.token_new || ed.token;
  if (!email || !token) {
    return jsonResponse(400, { error: "bad_request" });
  }

  // No mail provider configured (dev): capture the code server-side instead of sending.
  // Production always has ELASTIC_API_KEY set, so this branch never runs there.
  if (!ELASTIC_API_KEY) {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });
    const { error } = await db.from("dev_otps").insert({ email, token });
    if (error) return jsonResponse(500, { error: "dev_otp_store_failed" });
    console.warn("[otp-email] no ELASTIC_API_KEY: code captured in dev_otps (dev mode)");
    return jsonResponse(200, {});
  }

  const form = new URLSearchParams({
    apikey: ELASTIC_API_KEY,
    to: email,
    from: OTP_SENDER,
    fromName: "xChief Gold Rush",
    subject: `Your xChief Gold Rush code: ${token}`,
    template: "gold_rush_otp",
    merge_otp_code: token,
    isTransactional: "true",
  });

  const res = await fetch("https://api.elasticemail.com/v2/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  let result: { success?: boolean; error?: string };
  try {
    result = await res.json();
  } catch {
    return jsonResponse(500, { error: "elastic_email_bad_response" });
  }

  if (!res.ok || result.success === false) {
    return jsonResponse(500, { error: result.error ?? "elastic_email_send_failed" });
  }

  return jsonResponse(200, {});
});
