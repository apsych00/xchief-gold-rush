// Shared helpers for xChief Gold Rush edge functions.
import { createClient } from "npm:@supabase/supabase-js@2";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export interface RelayPrice {
  price: number;
  t: number;
}

// Reads the relay's current price and rejects anything older than 3s or not a
// finite positive number. The round's fairness depends on this check running
// at both the start and end of every round.
export async function readRelayPrice(url: string): Promise<RelayPrice> {
  const res = await fetch(url);
  if (!res.ok && res.status !== 503) {
    throw new Error("feed_stale");
  }
  const data = await res.json();
  const price = data?.price;
  const t = data?.t;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    throw new Error("feed_stale");
  }
  if (typeof t !== "number" || !Number.isFinite(t)) {
    throw new Error("feed_stale");
  }
  if (Date.now() - t > 3000) {
    throw new Error("feed_stale");
  }
  return { price, t };
}

// Service-role client: bypasses RLS, used for the write paths that own the
// 5-second clock and settle rounds server-side.
export function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Anon-key client, used only to verify the caller's JWT via auth.getUser.
export function anonClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_ANON_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
