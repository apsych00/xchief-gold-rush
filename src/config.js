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

const LINKS = {
  instagram: env.VITE_LINK_INSTAGRAM || 'https://www.instagram.com/xchief',
  telegram: env.VITE_LINK_TELEGRAM || 'https://t.me/xchief',
  youtube: env.VITE_LINK_YOUTUBE || 'https://www.youtube.com/@xchief',
  trustpilot: env.VITE_LINK_TRUSTPILOT || 'https://www.trustpilot.com/review/xchief.com',
  google: env.VITE_LINK_GOOGLE_REVIEW || 'https://www.google.com/search?q=xchief+reviews',
  fpa: env.VITE_LINK_FPA || 'https://www.forexpeacearmy.com/forex-reviews/xchief',
  demo: env.VITE_LINK_DEMO || 'https://www.xchief.com/',
  site: env.VITE_LINK_SITE || 'https://www.xchief.com/',
};

export const SHARE_URL = env.VITE_SHARE_URL || 'https://xchief-gold-rush.vercel.app';

const DAY = 24 * 60 * 60 * 1000;

/**
 * kind: 'video' | 'email' | 'link' | 'share'
 * repeatMs: undefined = one-time; number = can be claimed again after this long
 * Order matters: quick/cheap first, the big demo-account task last.
 */
export const TASKS = [
  { id: 'video', kind: 'video', reward: 100, repeatMs: 5 * 60 * 1000, icon: '▶' },
  { id: 'email', kind: 'email', reward: 200, icon: '✉' },
  { id: 'instagram', kind: 'link', reward: 300, url: LINKS.instagram, icon: '◎' },
  { id: 'telegram', kind: 'link', reward: 300, url: LINKS.telegram, icon: '✈' },
  { id: 'youtube', kind: 'link', reward: 300, url: LINKS.youtube, icon: '▷' },
  { id: 'story', kind: 'share', reward: 300, repeatMs: DAY, icon: '↗' },
  { id: 'review_trustpilot', kind: 'link', reward: 500, url: LINKS.trustpilot, icon: '★' },
  { id: 'review_google', kind: 'link', reward: 500, url: LINKS.google, icon: '★' },
  { id: 'review_fpa', kind: 'link', reward: 500, url: LINKS.fpa, icon: '★' },
  { id: 'demo', kind: 'link', reward: 1000, url: LINKS.demo, icon: '◆', featured: true },
];

export const LINKS_PUBLIC = LINKS;
