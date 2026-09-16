import { ECON } from './config.js';

const KEY = 'xchief.profile.v1';

export function defaultProfile() {
  return {
    coins: ECON.startCoins,
    record: ECON.startCoins,
    streak: 0,
    bestStreak: 0,
    rounds: 0,
    wins: 0,
    freeRefillUsed: false,
    prompts: {}, // prompt id -> timestamp it was shown ('email_win', 'email_lb', 'signup_broke', 'signup_trader')
    taskClaims: {}, // task id -> last claim timestamp (ms)
    roundTimes: [], // timestamps of recent rounds, for the hourly cap
    badges: [], // 'high_roller' | 'hot_streak' | 'comeback'
    createdAt: Date.now(),
    // Web identity (docs/layers.md C3, C4). null/false until the server's own `me` says
    // otherwise - the client never decides its own verification state.
    email: null,
    emailVerified: false,
    display: null, // this player's own masked email, once verified
  };
}

export function loadProfile() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultProfile();
    const p = JSON.parse(raw);
    return { ...defaultProfile(), ...p };
  } catch {
    return defaultProfile();
  }
}

export function saveProfile(p) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

export function resetProfile() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return defaultProfile();
}

export const todayKey = () => new Date().toISOString().slice(0, 10);
