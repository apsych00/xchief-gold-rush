/**
 * Game economy, levels and refill tasks. Everything a marketer may want to
 * tune lives here; links, PIN and video can also be set through env vars
 * (see .env.example) without touching code.
 */
const env = import.meta.env || {};

export const ECON = {
  startCoins: 1000, // welcome balance
  stakeBase: 100, // stake = stakeBase × lever
  levers: [1, 2, 5],
  brokeBelow: 100, // below this the player cannot afford the smallest stake
  // Combo: consecutive wins raise the payout multiplier. Index = wins in a
  // row BEFORE this round (0 = first win). A loss resets to the start.
  combo: [1, 1.5, 2, 3],
  freeRefill: 300, // one-time instant refill the first time a player goes broke
  maxRoundsPerHour: 60,
};

export const comboMult = (streak) => ECON.combo[Math.min(streak, ECON.combo.length - 1)];
export const COMBO_MAX = ECON.combo[ECON.combo.length - 1];

// Level titles by best-ever balance (record).
export const LEVELS = [
  { id: 'rookie', min: 0 },
  { id: 'trader', min: 2000 },
  { id: 'pro', min: 5000 },
  { id: 'chief', min: 10000 },
];

export function levelFor(record) {
  let cur = LEVELS[0];
  for (const l of LEVELS) if (record >= l.min) cur = l;
  return cur;
}

export function nextLevel(record) {
  return LEVELS.find((l) => l.min > record) || null;
}

// How social/link tasks are confirmed:
//   'timer' – link opens, "Done" unlocks after TASK_WAIT_MS (online campaigns)
//   'pin'   – same, but booth staff must also enter STAFF_PIN (expo mode)
export const VERIFY_MODE = env.VITE_TASK_VERIFY === 'pin' ? 'pin' : 'timer';
export const STAFF_PIN = String(env.VITE_STAFF_PIN || '1234');
export const TASK_WAIT_MS = 15000;
export const PROMO_VIDEO_URL = env.VITE_PROMO_VIDEO_URL || '';
export const PROMO_VIDEO_SECONDS = 15;

// instagram/telegram/youtube/trustpilot/google/fpa destinations moved into db/seed.sql (ticket
// B6+B7+B9 decision 1): the server's `tasks` rows carry their own `url` now, so a marketer
// changing a destination edits one seeded row instead of a client env var. Only the two links
// with no task behind them stay here.
const LINKS = {
  demo: env.VITE_LINK_DEMO || 'https://www.xchief.com/',
  site: env.VITE_LINK_SITE || 'https://www.xchief.com/',
};

export const SHARE_URL = env.VITE_SHARE_URL || 'https://xchief-gold-rush.vercel.app';

export const SIGNUP_PROMPT_LEVEL = 'trader'; // level whose first reach offers the signup

// Task icons, keyed by id: the one piece of the old client-side task table still worth keeping,
// since public.get_tasks() (ticket B6+B7+B9 decision 1) has no notion of an icon and never
// should - it is decoration, not a reward number. Everything else the tasks screen renders
// (title, reward, claimed, kind, url) comes from the server's own tasksRows.
export const TASK_ICONS = {
  signup: '◆',
  video: '▶',
  email: '✉',
  instagram: '◎',
  telegram: '✈',
  youtube: '▷',
  story: '↗',
  review_trustpilot: '★',
  review_google: '★',
  review_fpa: '★',
};

export const LINKS_PUBLIC = LINKS;
