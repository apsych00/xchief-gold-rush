// Shared harness for the blind HTTP integration suite.
// Reads the live dev backend config from .env at the repo root. Never prints values.
import { readFileSync } from 'node:fs';

function loadEnv() {
  const raw = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = loadEnv();
export const BASE_URL = env.VITE_SUPABASE_URL;
export const ANON_KEY = env.VITE_SUPABASE_ANON_KEY;
if (!BASE_URL || !ANON_KEY) {
  throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing from .env');
}

async function parseJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// All response bodies may echo live price data; report status + key names only.
function shape(value) {
  if (Array.isArray(value)) return `[${value.length} rows]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).join(',')}}`;
  return typeof value;
}

export function describeResponse(res, body) {
  return `HTTP ${res.status} body-shape=${shape(body)}`;
}

// Flatten every string in a JSON error payload so code checks do not depend
// on whether the backend puts the code in `error`, `message`, or similar.
export function errorText(body) {
  const parts = [];
  const walk = (v) => {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(body);
  return parts.join(' ');
}

export async function postJson(path, { body = {}, token = null, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', apikey: ANON_KEY, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE_URL + path, {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
  });
  return { res, json: await parseJson(res) };
}

export const fn = (name, opts) => postJson(`/functions/v1/${name}`, opts);
export const rpc = (name, opts) => postJson(`/rest/v1/rpc/${name}`, opts);

// A brand-new anonymous session, as a real client gets one: signup with an
// empty body (anonymous sign-ins enabled).
export async function newAnonymousSession() {
  const res = await fetch(`${BASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({}),
  });
  const json = await parseJson(res);
  if (!res.ok || !json.access_token || !json.user || !json.user.id) {
    throw new Error(`anonymous signup failed: HTTP ${res.status} keys=${Object.keys(json).join(',')}`);
  }
  return { token: json.access_token, userId: json.user.id };
}
