import { useCallback, useEffect, useRef, useState } from 'react';
import { comboMult, ECON, TASKS } from './config.js';
import { startPriceFeed } from './priceFeed.js';
import { loadProfile, resetProfile as wipeProfile, saveProfile } from './profile.js';
import { enabled as apiEnabled } from './api/client.js';
import * as api from './api/game.js';
import { ensureSession, requestOtp as sessionRequestOtp, signOut as sessionSignOut, verifyOtp as sessionVerifyOtp } from './api/session.js';
import { IS_KIOSK, playKioskRound } from './api/kiosk.js';
import { connect as connectSocket, onIdentityChange, onLeaderboard, onSettled } from './api/socket.js';

export const ROUND_SECONDS = 5;
export const LEVERS = ECON.levers;
const TICK_MS = 60;
const MAX_HISTORY = 90;
const HOUR = 60 * 60 * 1000;

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
  const settlingTimer = useRef(null);
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

  // Shared by the initial hydrate below, the re-login case (docs/layers.md C3a: verifying an
  // email that already belongs to a different player switches this socket's identity there),
  // and the OTP actions further down - every one of them lands a fresh players row and rebuilds
  // the profile from it the same way. `email`/`emailVerified`/`display` are ticket C3/C4's own
  // additions: display is this player's own masked email (docs/layers.md, "playing as
  // k****i@gmail.com"), the same string leaderboard rows use so matching "is this my row" is a
  // plain equality check.
  const applyMe = useCallback((row) => {
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
      email: row.email ?? null,
      emailVerified: !!row.email_verified,
      display: row.display ?? null,
    };
    profileRef.current = next;
    setProfile(next);
    return next;
  }, []);

  // Hydrate from the server once on load: sign in anonymously (or resume the
  // existing session) then pull the real balance/streak/record. Kiosk mode
  // has no session of its own - its identity is the bearer secret checked on
  // every round - so it skips this and stays cosmetic-local, but it still
  // needs the socket open (auth {kiosk}) to receive prices and verdicts.
  useEffect(() => {
    if (!apiEnabled) return undefined;
    if (IS_KIOSK) {
      connectSocket();
      return undefined;
    }
    let cancelled = false;
    const guardedApplyMe = (row) => {
      if (!cancelled) applyMe(row);
    };
    ensureSession()
      .then(() => api.getMe())
      .then(guardedApplyMe)
      .catch((err) => {
        console.error('[api] session bootstrap failed', err);
      });
    const offIdentityChange = onIdentityChange(guardedApplyMe);
    return () => {
      cancelled = true;
      offIdentityChange();
    };
  }, [applyMe]);

  // Live, masked leaderboard (docs/layers.md C4): re-renders `others` from whichever `me` this
  // socket currently is, so the own-row match below stays correct across a re-login mid-view.
  useEffect(() => {
    if (!apiEnabled || IS_KIOSK) return undefined;
    return onLeaderboard((rows) => {
      const myDisplay = profileRef.current.display;
      const mapped = rows.map((r) => ({
        name: r.display,
        s: r.record,
        me: myDisplay != null && r.display === myDisplay,
      }));
      setState((s) => ({ ...s, others: mapped }));
    });
  }, []);

  const stopTimer = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (settlingTimer.current) clearTimeout(settlingTimer.current);
    settlingTimer.current = null;
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

  // Applies a server verdict (web or kiosk) in place of the local settle(). Every field the
  // frame carries (outcome/delta/coins/record/best_streak for web; outcome/delta/mult/coins/
  // streak/coupon/coupons_exhausted for kiosk, server/rounds.js) is taken as-is - no local price
  // comparison, no recomputed win/lose, no recomputed payout. C1 added real coins to the kiosk's
  // own round_settled (kiosks.session_coins, settle_kiosk_round); trust that figure the same way
  // the web branch already does rather than re-deriving it from the local combo table, so a
  // missed frame or a client/server combo mismatch can never leave the displayed balance out of
  // step with what the server actually holds.
  //
  // `silent` is for a verdict that arrives for a round the player is no longer watching (the
  // "missed verdict" delivered once on reconnect, docs/box-plan.md 1.3): the profile is still
  // updated so the balance stays correct, but there is no result pane to show it in.
  const applyVerdict = useCallback(
    (isKiosk, verdict, { silent = false } = {}) => {
      const p = profileRef.current;
      let next = { ...p, rounds: p.rounds + 1 };
      let result;
      const endPrice = verdict.end_price;
      if (isKiosk) {
        next.coins = verdict.coins;
        next.record = Math.max(p.record, verdict.coins);
        next.streak = verdict.streak;
        next.bestStreak = Math.max(p.bestStreak, verdict.streak);
        next.wins = verdict.outcome === 'win' ? p.wins + 1 : p.wins;
        result = {
          outcome: verdict.outcome,
          stake: stakeFor(levRef.current),
          delta: verdict.delta,
          mult: verdict.mult,
          streak: verdict.streak,
          badge: null,
          coupon: verdict.coupon || null,
        };
        if (!silent && verdict.coupons_exhausted) toast('Prize pool empty - please tell the staff', 5000);
      } else {
        next = {
          ...next,
          coins: verdict.coins,
          record: verdict.record,
          streak: verdict.streak,
          bestStreak: Math.max(p.bestStreak, verdict.best_streak ?? verdict.streak),
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
      if (silent) return;
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
    },
    [toast],
  );

  // The verdict for a round arrives on its own, once the server's 5-second timer fires and it
  // has read the price itself (docs/box-plan.md 1.3) - it is not the reply to `play`. This is
  // the one place both web and kiosk hear it.
  useEffect(() => {
    if (!apiEnabled) return undefined;
    return onSettled((verdict) => {
      const wasRunning = phaseRef.current === 'running';
      if (wasRunning) stopTimer();
      applyVerdict(IS_KIOSK, verdict, { silent: !wasRunning });
    });
  }, [applyVerdict, stopTimer]);

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
            // The countdown is purely visual once apiEnabled: it holds here until the
            // round_settled verdict arrives via onSettled above. If it takes more than 2 s
            // past the countdown's own end, say so rather than sit on a frozen "0" - never
            // fabricate a verdict (docs/box-plan.md, "Late verdict").
            setState((c) => ({ ...c, remaining: 0, history: [...c.history, price].slice(-MAX_HISTORY) }));
            if (!settlingTimer.current) {
              settlingTimer.current = setTimeout(() => {
                if (phaseRef.current === 'running') toast('Settling…', 6000);
              }, 2000);
            }
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
        const call = IS_KIOSK ? playKioskRound(dir, lever) : api.playRound(dir, lever);
        call
          .then((opened) => {
            // round_opened only, not the verdict (docs/box-plan.md 1.3): the visual countdown
            // is already running above; this just corrects the pinned start price to the
            // server's own. The verdict itself arrives later, through onSettled.
            patch({ start: opened.start_price });
          })
          .catch((err) => {
            stopTimer();
            phaseRef.current = 'idle';
            toast(err?.code === 'feed_stale' ? 'feed' : err?.code || 'error');
            patch({ phase: 'idle', dir: null, start: null, end: null, history: [], result: null });
          });
      }
    },
    [patch, settle, stopTimer, toast],
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
            // The socket's claim_task reply is the player's current state, not the reward
            // amount (server/index.js sends `me`, not the claim_task RPC's own {coins, reward}
            // json) - the coin delta the server actually applied is what res.coins - p.coins
            // says, so the toast reads that rather than guessing at a reward figure.
            const gained = res.coins - p.coins;
            const next = {
              ...p,
              coins: res.coins,
              record: Math.max(p.record, res.coins),
              taskClaims: { ...p.taskClaims, [taskId]: Date.now() },
            };
            profileRef.current = next;
            setProfile(next);
            toast(`+${gained}`);
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
          const gained = res.coins - p.coins; // see the same note in claimTask above
          const next = { ...p, coins: res.coins, record: Math.max(p.record, res.coins), freeRefillUsed: true };
          profileRef.current = next;
          setProfile(next);
          toast(`+${gained}`);
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

  // The public top-10; refetched each time the leaderboard screen opens so it reflects the
  // latest server state (docs/layers.md C4). Rows are masked emails, not names: the current
  // player's own row is marked `me` by an exact match on its own masked email (profile.display)
  // rather than excluded, so a verified player in the top 10 sees themself highlighted in
  // place, same as the live push in the effect above.
  const refreshLeaderboard = useCallback(() => {
    if (!apiEnabled || IS_KIOSK) return;
    api
      .getLeaderboard()
      .then((rows) => {
        const myDisplay = profileRef.current.display;
        const mapped = rows.map((r) => ({
          name: r.display,
          s: r.record,
          me: myDisplay != null && r.display === myDisplay,
        }));
        setState((s) => ({ ...s, others: mapped }));
      })
      .catch((err) => console.error('[api] leaderboard fetch failed', err));
  }, []);

  /** Requests an 8-digit code for `email` (docs/layers.md C3). */
  const requestOtp = useCallback((email) => sessionRequestOtp(email), []);

  /** Verifies the code and applies whatever `me` came back - the same player with its score
   * kept, or, on a re-login (docs/layers.md C3a), the existing verified player that email
   * already belongs to. `identityChanged` tells the OTP screen which one happened: it is true
   * exactly when the server's `me` carried a fresh token, its own signal for a re-login
   * (src/api/socket.js's handleMe).
   *
   * The OTP entry point lives on the leaderboard screen itself (the guest row); a live push
   * only arrives after this player's next round settles, so without this the leaderboard
   * behind the modal would keep showing the pre-verification guest row until the player left
   * the screen and came back. A verify is rare enough that one extra fetch here is free. */
  const verifyOtp = useCallback(
    (email, code) =>
      sessionVerifyOtp(email, code).then((me) => {
        const next = applyMe(me);
        refreshLeaderboard();
        return { ...next, identityChanged: !!me.token };
      }),
    [applyMe, refreshLeaderboard],
  );

  const signOut = useCallback(() => sessionSignOut(), []);

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
    goProfile: () => {
      stopTimer();
      patch({ screen: 'profile', ...reset });
    },
    resetProfile: () => {
      stopTimer();
      const fresh = wipeProfile();
      try {
        ['xchief.lead', 'xchief.signup', 'xchief.prompts'].forEach((k) => localStorage.removeItem(k));
      } catch {
        /* ignore */
      }
      profileRef.current = fresh;
      setProfile(fresh);
      patch({ screen: 'home', ...reset });
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
    requestOtp,
    verifyOtp,
    signOut,
  };

  return { state, profile, actions, trackRef, isKiosk: IS_KIOSK };
}
