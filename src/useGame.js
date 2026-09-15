import { useCallback, useEffect, useRef, useState } from 'react';
import { comboMult, ECON, TASKS } from './config.js';
import { startPriceFeed } from './priceFeed.js';
import { loadProfile, saveProfile } from './profile.js';
import { enabled as apiEnabled } from './api/client.js';
import * as api from './api/game.js';
import { ensureSession } from './api/session.js';
import { getKioskSecret, playKioskRound } from './api/kiosk.js';

export const ROUND_SECONDS = 5;
export const LEVERS = ECON.levers;
const TICK_MS = 60;
const MAX_HISTORY = 90;
const HOUR = 60 * 60 * 1000;

// Read once: a kiosk's launch URL is fixed, so its secret never changes mid-session.
const KIOSK_SECRET = getKioskSecret();
const IS_KIOSK = apiEnabled && !!KIOSK_SECRET;

const OTHERS = [
  { name: 'GoldHunter', s: 3600 },
  { name: 'Alpha', s: 3200 },
  { name: 'GoldPilot', s: 2800 },
  { name: 'Nova', s: 2700 },
  { name: 'Titan', s: 2650 },
  { name: 'Rex', s: 2550 },
  { name: 'Mira', s: 2480 },
];

export const stakeFor = (lev) => ECON.stakeBase * lev;
export const maxAffordableLever = (coins) => {
  let best = null;
  for (const l of LEVERS) if (stakeFor(l) <= coins) best = l;
  return best;
};

const initialGame = {
  screen: 'home', // 'home' | 'game' | 'lb' | 'tasks'
  phase: 'idle', // 'idle' | 'running' | 'result'
  lev: 1,
  dir: null,
  price: null,
  start: null,
  end: null,
  remaining: ROUND_SECONDS,
  history: [],
  drag: false,
  others: OTHERS,
  feed: { mode: 'connecting', source: null, symbol: null, quiet: false },
  // last settled round
  result: null, // { outcome:'win'|'lose'|'flat', stake, delta, mult, streak, badge, coupon? }
  toast: null, // { id, text } transient notice
};

export function useGame() {
  const [state, setState] = useState(initialGame);
  const [profile, setProfile] = useState(loadProfile);
  const timer = useRef(null);
  const phaseRef = useRef(state.phase);
  const dragRef = useRef(false);
  const priceRef = useRef(null);
  const profileRef = useRef(profile);
  const trackRef = useRef(null);
  const toastTimer = useRef(null);

  const levRef = useRef(state.lev);
  const stateRef = useRef(state);
  phaseRef.current = state.phase;
  profileRef.current = profile;
  levRef.current = state.lev;
  stateRef.current = state;

  useEffect(() => saveProfile(profile), [profile]);

  // Hydrate from the server once on load: sign in anonymously (or resume the
  // existing session) then pull the real balance/streak/record. Kiosk mode
  // has no session of its own - its identity is the bearer secret checked on
  // every round - so it skips this and stays cosmetic-local.
  useEffect(() => {
    if (!apiEnabled || IS_KIOSK) return undefined;
    let cancelled = false;
    ensureSession()
      .then(() => api.getMe())
      .then((row) => {
        if (cancelled) return;
        const next = {
          ...profileRef.current,
          coins: row.coins,
          record: row.record,
          streak: row.streak,
          bestStreak: row.best_streak,
          wins: row.wins,
          rounds: row.rounds,
          freeRefillUsed: row.free_refill_used,
          displayName: row.display_name,
        };
        profileRef.current = next;
        setProfile(next);
      })
      .catch((err) => {
        console.error('[api] session bootstrap failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const stopTimer = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  const patch = useCallback((p) => setState((s) => ({ ...s, ...p })), []);

  const toast = useCallback(
    (text, ms = 2600) => {
      clearTimeout(toastTimer.current);
      const id = Date.now();
      patch({ toast: { id, text } });
      toastTimer.current = setTimeout(
        () => setState((s) => (s.toast && s.toast.id === id ? { ...s, toast: null } : s)),
        ms,
      );
    },
    [patch],
  );

  // Live price feed
  useEffect(() => {
    const stop = startPriceFeed({
      onPrice: (price) => {
        priceRef.current = price;
        setState((s) => (s.price === price ? s : { ...s, price }));
      },
      onStatus: (feed) => setState((s) => ({ ...s, feed })),
    });
    return () => {
      stop();
      stopTimer();
      clearTimeout(toastTimer.current);
    };
  }, [stopTimer]);

  // Keep the selected lever affordable while idle.
  useEffect(() => {
    if (state.phase !== 'idle') return;
    const max = maxAffordableLever(profile.coins);
    if (max !== null && stakeFor(state.lev) > profile.coins) patch({ lev: max });
  }, [profile.coins, state.lev, state.phase, patch]);

  const roundsInLastHour = (p) => p.roundTimes.filter((t) => Date.now() - t < HOUR).length;

  // Settlement runs outside any React updater: updaters can be invoked more
  // than once (eager compute + render), which would pay a round twice.
  const settle = useCallback((dir, endPrice) => {
    const cur = stateRef.current;
    const p = profileRef.current;
    const stake = stakeFor(cur.lev);
    const tie = endPrice === cur.start;
    const win = !tie && (dir === 'up') === endPrice > cur.start;
    let next = { ...p, rounds: p.rounds + 1 };
    let result;
    if (tie) {
      // Flat keeps the combo but does not grow it.
      result = { outcome: 'flat', stake, delta: 0, mult: comboMult(p.streak), streak: p.streak, badge: null };
    } else if (win) {
      const mult = comboMult(p.streak); // multiplier earned by the wins before this one
      const streak = p.streak + 1;
      const gain = Math.round(stake * mult);
      const coins = p.coins + gain;
      const badges = [...p.badges];
      let badge = null;
      if (cur.lev === 5 && !badges.includes('high_roller')) {
        badges.push('high_roller');
        badge = 'high_roller';
      }
      if (streak >= 4 && !badges.includes('hot_streak')) {
        badges.push('hot_streak');
        badge = 'hot_streak';
      }
      if (coins > p.record && p.coins < ECON.brokeBelow + stake && !badges.includes('comeback')) {
        badges.push('comeback');
        badge = 'comeback';
      }
      next = {
        ...next,
        coins,
        record: Math.max(p.record, coins),
        streak,
        bestStreak: Math.max(p.bestStreak, streak),
        wins: p.wins + 1,
        badges,
      };
      result = { outcome: 'win', stake, delta: gain, mult, streak, badge };
    } else {
      next = { ...next, coins: Math.max(0, p.coins - stake), streak: 0 };
      result = { outcome: 'lose', stake, delta: -stake, mult: 1, streak: 0, badge: null };
    }
    profileRef.current = next;
    setProfile(next);
    setState((s) => ({
      ...s,
      phase: 'result',
      price: endPrice,
      end: endPrice,
      remaining: 0,
      history: [...s.history, endPrice],
      result,
    }));
  }, []);

  // Applies a server verdict (web or kiosk) in place of the local settle().
  // Kiosk coins/lever are cosmetic (the spec: "coins/levers are ignored for
  // kiosk"), so a kiosk win/lose still runs the local combo math on top of
  // the server-decided outcome and streak.
  const applyVerdict = useCallback((isKiosk, verdict) => {
    const cur = stateRef.current;
    const p = profileRef.current;
    let next = { ...p, rounds: p.rounds + 1 };
    let result;
    let endPrice;
    if (isKiosk) {
      endPrice = priceRef.current ?? cur.start;
      const stake = stakeFor(levRef.current);
      if (verdict.outcome === 'win') {
        const mult = comboMult(p.streak);
        const gain = Math.round(stake * mult);
        const coins = p.coins + gain;
        next = {
          ...next,
          coins,
          record: Math.max(p.record, coins),
          streak: verdict.streak,
          bestStreak: Math.max(p.bestStreak, verdict.streak),
          wins: p.wins + 1,
        };
        result = { outcome: 'win', stake, delta: gain, mult, streak: verdict.streak, badge: null, coupon: verdict.coupon || null };
      } else if (verdict.outcome === 'lose') {
        next = { ...next, coins: Math.max(0, p.coins - stake), streak: 0 };
        result = { outcome: 'lose', stake, delta: -stake, mult: 1, streak: 0, badge: null, coupon: null };
      } else {
        result = { outcome: 'flat', stake, delta: 0, mult: comboMult(p.streak), streak: p.streak, badge: null, coupon: null };
      }
    } else {
      endPrice = verdict.end_price;
      next = {
        ...next,
        coins: verdict.coins,
        record: verdict.record,
        streak: verdict.streak,
        bestStreak: Math.max(p.bestStreak, verdict.streak),
        wins: verdict.outcome === 'win' ? p.wins + 1 : p.wins,
      };
      result = {
        outcome: verdict.outcome,
        stake: stakeFor(levRef.current),
        delta: verdict.delta,
        mult: verdict.mult,
        streak: verdict.streak,
        badge: null,
        coupon: null,
      };
    }
    profileRef.current = next;
    setProfile(next);
    phaseRef.current = 'result';
    setState((s) => ({
      ...s,
      phase: 'result',
      price: endPrice,
      end: endPrice,
      remaining: 0,
      history: [...s.history, endPrice],
      result,
    }));
  }, []);

  const startRound = useCallback(
    (dir) => {
      if (phaseRef.current !== 'idle') return;
      const start = priceRef.current;
      if (start == null) return;
      const p = profileRef.current;
      const stake = stakeFor(levRef.current);
      if (p.coins < stake) return;
      if (roundsInLastHour(p) >= ECON.maxRoundsPerHour) {
        toast('limit');
        return;
      }
      phaseRef.current = 'running';
      stopTimer();
      const now = Date.now();
      setProfile({ ...p, roundTimes: [...p.roundTimes.filter((t) => now - t < HOUR), now] });
      patch({ dir, phase: 'running', start, remaining: ROUND_SECONDS, history: [start], result: null });
      const t0 = performance.now();
      timer.current = setInterval(() => {
        const elapsed = (performance.now() - t0) / 1000;
        const price = priceRef.current ?? start;
        if (elapsed >= ROUND_SECONDS) {
          if (!apiEnabled) {
            stopTimer();
            settle(dir, price);
          } else {
            // The countdown is purely visual once apiEnabled: it holds here
            // until the server verdict below arrives.
            setState((c) => ({ ...c, remaining: 0, history: [...c.history, price].slice(-MAX_HISTORY) }));
          }
          return;
        }
        setState((c) => ({
          ...c,
          remaining: ROUND_SECONDS - elapsed,
          history: [...c.history, price].slice(-MAX_HISTORY),
        }));
      }, TICK_MS);

      if (apiEnabled) {
        const lever = levRef.current;
        const call = IS_KIOSK ? playKioskRound(dir) : api.playRound(dir, lever);
        call
          .then((verdict) => {
            stopTimer();
            applyVerdict(IS_KIOSK, verdict);
          })
          .catch((err) => {
            stopTimer();
            phaseRef.current = 'idle';
            toast(err?.code === 'feed_stale' ? 'feed' : err?.code || 'error');
            patch({ phase: 'idle', dir: null, start: null, end: null, history: [], result: null });
          });
      }
    },
    [applyVerdict, patch, settle, stopTimer, toast],
  );

  const setLevFromEvent = useCallback(
    (e) => {
      const el = trackRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const p = 1 - Math.min(1, Math.max(0, (e.clientY - r.top - 18) / (r.height - 36)));
      const want = p < 0.3 ? 1 : p < 0.75 ? 2 : 5;
      const max = maxAffordableLever(profileRef.current.coins);
      patch({ lev: max === null ? 1 : Math.min(want, max) });
    },
    [patch],
  );

  const reset = { phase: 'idle', dir: null, start: null, end: null, history: [], result: null };

  const claimTask = useCallback(
    (taskId) => {
      if (apiEnabled && !IS_KIOSK) {
        api
          .claimTask(taskId)
          .then((res) => {
            const p = profileRef.current;
            const next = {
              ...p,
              coins: res.coins,
              record: Math.max(p.record, res.coins),
              taskClaims: { ...p.taskClaims, [taskId]: Date.now() },
            };
            profileRef.current = next;
            setProfile(next);
            toast(`+${res.reward}`);
          })
          .catch((err) => toast(err?.code || 'error'));
        return true;
      }
      const task = TASKS.find((t) => t.id === taskId);
      if (!task) return false;
      const p = profileRef.current;
      const last = p.taskClaims[taskId];
      if (last && (!task.repeatMs || Date.now() - last < task.repeatMs)) return false;
      const coins = p.coins + task.reward;
      const next = {
        ...p,
        coins,
        record: Math.max(p.record, coins),
        taskClaims: { ...p.taskClaims, [taskId]: Date.now() },
      };
      profileRef.current = next;
      setProfile(next);
      toast(`+${task.reward}`);
      return true;
    },
    [toast],
  );

  const freeRefill = useCallback(() => {
    if (apiEnabled && !IS_KIOSK) {
      api
        .freeRefill()
        .then((res) => {
          const p = profileRef.current;
          const next = { ...p, coins: res.coins, record: Math.max(p.record, res.coins), freeRefillUsed: true };
          profileRef.current = next;
          setProfile(next);
          toast(`+${res.reward}`);
        })
        .catch((err) => toast(err?.code || 'error'));
      return true;
    }
    const p = profileRef.current;
    if (p.freeRefillUsed || p.coins >= ECON.brokeBelow) return false;
    const coins = p.coins + ECON.freeRefill;
    const next = { ...p, coins, record: Math.max(p.record, coins), freeRefillUsed: true };
    profileRef.current = next;
    setProfile(next);
    toast(`+${ECON.freeRefill}`);
    return true;
  }, [toast]);

  // The public top-10; refetched each time the leaderboard screen opens so it
  // reflects the latest server state. Excludes the current player's own row
  // (identified by display_name) since the screen appends "you" itself.
  const refreshLeaderboard = useCallback(() => {
    if (!apiEnabled || IS_KIOSK) return;
    api
      .getLeaderboard()
      .then((rows) => {
        const me = profileRef.current.displayName;
        const mapped = rows.filter((r) => r.display_name !== me).map((r) => ({ name: r.display_name, s: r.record }));
        setState((s) => ({ ...s, others: mapped }));
      })
      .catch((err) => console.error('[api] leaderboard fetch failed', err));
  }, []);

  /** Record that an automatic prompt was shown so it is never repeated. */
  const markPrompt = useCallback((id) => {
    const p = profileRef.current;
    if (p.prompts[id]) return;
    const next = { ...p, prompts: { ...p.prompts, [id]: Date.now() } };
    profileRef.current = next;
    setProfile(next);
  }, []);

  const actions = {
    go: (screen) => patch({ screen }),
    freeRefill,
    markPrompt,
    startGame: () => patch({ screen: 'game' }),
    goHome: () => {
      stopTimer();
      patch({ screen: 'home', ...reset });
    },
    goLeaderboard: () => {
      refreshLeaderboard();
      patch({ screen: 'lb' });
    },
    goTasks: () => {
      stopTimer();
      patch({ screen: 'tasks', ...reset });
    },
    playAgain: () => patch(reset),
    pickUp: () => startRound('up'),
    pickDown: () => startRound('down'),
    sliderDown: (e) => {
      if (phaseRef.current !== 'idle') return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = true;
      patch({ drag: true });
      setLevFromEvent(e);
    },
    sliderMove: (e) => {
      if (dragRef.current && phaseRef.current === 'idle') setLevFromEvent(e);
    },
    sliderUp: () => {
      dragRef.current = false;
      patch({ drag: false });
    },
    setLev: (lev) => {
      if (phaseRef.current !== 'idle' || !LEVERS.includes(lev)) return;
      if (stakeFor(lev) > profileRef.current.coins) return;
      patch({ lev });
    },
    claimTask,
    toast,
  };

  return { state, profile, actions, trackRef };
}
