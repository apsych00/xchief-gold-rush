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
    lastWinDay: null, // 'YYYY-MM-DD' of the last day a first-win bonus was paid
    taskClaims: {}, // task id -> last claim timestamp (ms)
    roundTimes: [], // timestamps of recent rounds, for the hourly cap
    badges: [], // 'high_roller' | 'hot_streak' | 'comeback'
    createdAt: Date.now(),
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
