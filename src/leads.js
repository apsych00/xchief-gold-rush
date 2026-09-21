/**
 * Lead storage and the "ask at the right moment" rules.
 *
 * Two leads are collected, both email only (ticket B4, docs/tasks-marketing-lead.md ground
 * rules: "Only the email identifies a web player"):
 *   - email    : one field, asked after the first win, then on entering the
 *                leaderboard top 10, else available as a task
 *   - signup   : email for an xChief account, asked when the player goes broke or reaches
 *                Trader, else the featured task
 *
 * Coins are paid for the in-game form, which we can verify, not for the
 * external registration, which we cannot (no webhook from xChief yet).
 *
 * Each automatic prompt is shown at most once per device (`prompts`), so a
 * player who declines is never nagged; the Coins tab keeps both available.
 */
export const LEAD_KEY = 'xchief.lead';
export const SIGNUP_KEY = 'xchief.signup';
export const PROMPTS_KEY = 'xchief.prompts';

const read = (key) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
};

export const readLead = () => read(LEAD_KEY);
export const readSignup = () => read(SIGNUP_KEY);
export const readPrompts = () => read(PROMPTS_KEY) || {};

/**
 * The one rule every email ask in the app goes through (never ask for an email we already
 * have): a prompt may appear only when the app KNOWS the player has no verified email - not
 * merely when it has not been told that they do. `identityKnown` flips true once this
 * session's own `me` row has landed from the server (src/useGame.js's applyMe), and
 * `profile.emailVerified` is that row's own flag - the server is the only authority on
 * identity, never localStorage. Until then the player is unknown, and unknown behaves like
 * "do not ask": during the connect window a verified user is indistinguishable from a brand
 * new one, so a guard of any other shape can fire at exactly the wrong person.
 *
 * Every guard reads through this helper rather than negating the flag itself; the unit test
 * test/unit/email-ask-rule.test.mjs fails any direct `!profile.emailVerified` read outside
 * here, so a new entry point cannot reintroduce the old shape.
 */
export const mayAskEmail = (identityKnown, profile) => identityKnown && !profile.emailVerified;

export function markPrompt(id) {
  write(PROMPTS_KEY, { ...readPrompts(), [id]: Date.now() });
}
export const promptShown = (id) => !!readPrompts()[id];

/** POST to the API without blocking the UI; keepalive survives a tab close. */
function ship(payload) {
  fetch('/api/lead', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {});
}

export function submitLead(payload) {
  write(LEAD_KEY, { ...payload, at: Date.now() });
  ship({ type: 'email', ...payload });
}

export function submitSignup(payload) {
  write(SIGNUP_KEY, { ...payload, at: Date.now() });
  // A signup also counts as an email lead.
  if (!readLead()) write(LEAD_KEY, { email: payload.email, source: payload.source, at: Date.now() });
  ship({ type: 'signup', ...payload });
}

/** Build the xChief registration URL with the lead's email prefilled. */
export function registerUrl(base, { email } = {}) {
  try {
    const u = new URL(base);
    if (email) u.searchParams.set('email', email);
    u.searchParams.set('utm_source', 'gold-rush');
    u.searchParams.set('utm_medium', 'game');
    return u.toString();
  } catch {
    return base;
  }
}
