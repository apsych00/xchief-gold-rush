import { useCallback, useEffect, useRef, useState } from 'react';
import { comboMult, ECON } from './config.js';
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

// The web tour flag (ticket B10): an ISO timestamp set the moment the placeholder tour is
// dismissed, its own localStorage key rather than a field on the profile object - it is not a
// reward and has no server side at all (docs/tasks-marketing-lead.md A5). Kiosk mode never
// reads or writes this key (docs/layers.md: kiosk never touches localStorage); its own once-
// per-boot intro flag lives in src/useKioskFlow.js instead.
const TOUR_SEEN_KEY = 'xchief.tour_seen';

function readTourSeen() {
  try {
    return localStorage.getItem(TOUR_SEEN_KEY);
  } catch {
    return null;
  }
}

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
  // Tournament header and switcher list (ticket B1): null/[] until the leaderboard screen's
  // first fetch or push. `tournament` is null while no tournament is running.
  tournament: null,
  tournaments: [],
  // Paging and the player's own row (ticket B2): `me` is this player's own row from
  // public.my_rank() - matched by player id, never a masked-email string (closes gap G3) - or
  // null for a guest/unverified player. `legend` (ticket B3) is set once from whichever request
  // reply carried it and kept across the unsolicited live push, which never carries one.
  page: 1,
  pages: 1,
  total: 0,
  me: null,
  legend: [],
  feed: { mode: 'connecting', source: null, symbol: null, quiet: false, connectionRefused: false },
  // last settled round
  result: null, // { outcome:'win'|'lose'|'flat', stake, delta, mult, streak, badge, coupon? }
  toast: null, // { id, text } transient notice
  // Task definitions plus this player's own claimed state, computed server-side by
  // public.get_tasks() (docs/layers.md C5; ticket B6+B7+B9 decision 1). Empty until the first
  // fetch; kiosk and offline (apiEnabled false) modes never populate it - there is no local
  // fallback any more, the client keeps no task table of its own.
  tasksRows: [],
};

export function useGame() {
  const [state, setState] = useState(initialGame);
  const [profile, setProfile] = useState(loadProfile);
  // IS_KIOSK is never true here for the web build, only defence in depth: the kiosk never reads
  // or writes this key even if this hook is ever reached from a kiosk context.
  const [tourSeen, setTourSeen] = useState(() => (IS_KIOSK ? 'kiosk' : readTourSeen()));
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
  // k****i@gmail.com"), shown in the identity bar - the leaderboard's own-row match no longer
  // uses it (ticket B2 decision 1, closes gap G3): see applyLeaderboardPayload below.
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

  // Applies one `leaderboard`-shaped frame (ticket B2), whether it is a direct request's reply
  // or the unsolicited live push (docs/layers.md C4) - both share this exact shape. `rows` are
  // already ranked and tiered server-side; `me` is this player's own row from
  // public.my_rank(), matched by player id, or null for a guest/unverified player - never a
  // masked-email string comparison (closes gap G3). `legend` (ticket B3) only ever arrives on a
  // direct request, so a push (which carries none) keeps whatever legend is already in state.
  const applyLeaderboardPayload = useCallback((payload) => {
    const { rows, tournament, tournaments, page, pages, total, me, legend } = payload;
    setState((s) => ({
      ...s,
      others: rows,
      tournament,
      tournaments,
      page: page ?? 1,
      pages: pages ?? 1,
      total: total ?? 0,
      me: me ?? null,
      legend: legend ?? s.legend,
    }));
  }, []);

  // Task definitions plus this player's own claimed state (docs/layers.md C5): fetched on
  // hydrate, on every visit to the tasks screen, and refreshed locally right after a claim -
  // never assembled from localStorage or src/config.js's reward numbers.
  const refreshTasks = useCallback(() => {
    if (!apiEnabled || IS_KIOSK) return;
    api
      .getTasks()
      .then((rows) => setState((s) => ({ ...s, tasksRows: rows })))
      .catch((err) => console.error('[api] tasks fetch failed', err));
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
      .then(() => {
        if (!cancelled) refreshTasks();
      })
      .catch((err) => {
        console.error('[api] session bootstrap failed', err);
      });
    const offIdentityChange = onIdentityChange(guardedApplyMe);
    return () => {
      cancelled = true;
      offIdentityChange();
    };
  }, [applyMe, refreshTasks]);

  // Live, masked leaderboard (docs/layers.md C4, ticket B2): every push and every request reply
  // share this same frame shape, so one applier handles both - see applyLeaderboardPayload
  // below. The live push always carries page 1 of the currently running tournament; if the
  // player has paged or switched tournaments, this snaps the view back to that live board on
  // the next settle. Deliberate: per-page/per-tournament live merging is C4b's animation work,
  // not this ticket's.
  useEffect(() => {
    if (!apiEnabled || IS_KIOSK) return undefined;
    return onLeaderboard(applyLeaderboardPayload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // C6 audit note: `result.stake` below is the one field in this object the round_settled frame
  // never carries (server/rounds.js, db/schema.sql's settle_round/settle_kiosk_round json).
  // It is not an outcome the server decides, though - it is the wager this same client already
  // sent in its own `play` frame and the server validated before opening the round, and lev is
  // locked for the whole running phase (setLev bails unless phase is idle), so it cannot have
  // changed under the round. Every other field here - outcome/delta/mult/coins/streak/
  // best_streak/coupon - is taken from `verdict` as-is.
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
      // Kiosk has no Play Again tap between rounds (App.jsx's Console leaves the buttons
      // unlocked through 'result'); a tap on up/down there starts the next round directly,
      // same as it would from 'idle'. The web flow still only ever starts from 'idle' - its
      // buttons stay locked until the explicit Play Again tap resets the phase.
      const canStart = IS_KIOSK ? phaseRef.current !== 'running' : phaseRef.current === 'idle';
      if (!canStart) return;
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

  // Once per device or per verified email, computed server-side (docs/layers.md C5; ticket
  // B6+B7+B9 decision 5): the client keeps no task table of its own, so there is no offline
  // fallback here any more - a task can only ever be claimed with a live server.
  const claimTask = useCallback(
    (taskId) => {
      if (!apiEnabled || IS_KIOSK) return false;
      api
        .claimTask(taskId)
        .then((res) => {
          // server/index.js's claim_task reply is `{type:'me', ...me, reward, task}`: the
          // full player row (applied the same way get_me's own reply is) plus the exact
          // reward the ledger just granted (docs/layers.md C5) - never guessed from a coin
          // delta or a client-side reward table.
          applyMe(res);
          setState((s) => ({
            ...s,
            tasksRows: s.tasksRows.map((r) => (r.id === res.task ? { ...r, claimed: true } : r)),
          }));
          toast(`+${res.reward}`);
        })
        .catch((err) => toast(err?.code || 'error'));
      return true;
    },
    [applyMe, toast],
  );

  // Video watch progress (ticket B6): reported by the player's own <video> element (or the
  // no-asset countdown fallback), at most every 5 s and once on ended. The server releases the
  // reward itself once 90% is crossed - this call never claims anything on its own, it only
  // reports what was observed; `reward` on the reply is present only on the call that crossed
  // the threshold.
  const reportVideoProgress = useCallback(
    (taskId, seconds, duration) => {
      if (!apiEnabled || IS_KIOSK) return;
      api
        .reportTaskProgress(taskId, seconds, duration)
        .then((res) => {
          applyMe(res);
          if (res.reward != null) {
            setState((s) => ({
              ...s,
              tasksRows: s.tasksRows.map((r) => (r.id === taskId ? { ...r, claimed: true } : r)),
            }));
            toast(`+${res.reward}`);
          }
        })
        .catch((err) => console.error('[api] task_progress failed', err));
    },
    [applyMe, toast],
  );

  // Redirect and return (ticket B7): opens the server's 5 s window before the destination URL
  // is opened, so the return side has something to measure against.
  const startTaskVisit = useCallback((taskId) => {
    if (!apiEnabled || IS_KIOSK) return Promise.resolve({ window_ms: 5000 });
    return api.startTaskVisit(taskId);
  }, []);

  // Redirect and return (ticket B7): reported when the tab regains focus. Rejects with
  // `not_yet` (carrying `.retryMs`) before the window has passed, or `already_claimed`.
  const returnTaskVisit = useCallback(
    (taskId) => {
      if (!apiEnabled || IS_KIOSK) return Promise.reject(Object.assign(new Error('not_available'), { code: 'not_available' }));
      return api.returnTaskVisit(taskId).then((res) => {
        applyMe(res);
        setState((s) => ({
          ...s,
          tasksRows: s.tasksRows.map((r) => (r.id === taskId ? { ...r, claimed: true } : r)),
        }));
        toast(`+${res.reward}`);
        return res;
      });
    },
    [applyMe, toast],
  );

  const freeRefill = useCallback(() => {
    if (apiEnabled && !IS_KIOSK) {
      api
        .freeRefill()
        .then((res) => {
          // server/index.js's free_refill reply is `{type:'me', ...me, reward}` - same shape
          // and same reasoning as claim_task's above.
          applyMe(res);
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
  }, [applyMe, toast]);

  /** Refetches whichever page the pager buttons should land on next: same tournament (or
   * whichever is current, if none is explicitly selected) and page. */
  const fetchLeaderboard = useCallback((tournament, page) => {
    if (!apiEnabled || IS_KIOSK) return;
    api
      .getLeaderboard({ tournament, page })
      .then(applyLeaderboardPayload)
      .catch((err) => console.error('[api] leaderboard fetch failed', err));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshLeaderboard = useCallback(() => fetchLeaderboard(null, 1), [fetchLeaderboard]);

  /** Switches the leaderboard screen to a specific tournament's own board - past or upcoming
   * (ticket B1's switcher), reset to page 1. `null` goes back to whichever tournament is
   * currently running. */
  const selectTournament = useCallback((id) => fetchLeaderboard(id, 1), [fetchLeaderboard]);

  /** Prev/Next (ticket B2 decision 4): pages within whichever tournament is currently on
   * screen (state.tournament?.id - `null` once no tournament is running or none was ever
   * fetched, which already means "whichever is current" to the server). Clamped to
   * [1, state.pages] and a no-op at either edge. */
  const gotoLeaderboardPage = useCallback(
    (delta) => {
      const s = stateRef.current;
      const target = Math.min(Math.max(1, (s.page || 1) + delta), Math.max(1, s.pages || 1));
      if (target === s.page) return;
      fetchLeaderboard(s.tournament ? s.tournament.id : null, target);
    },
    [fetchLeaderboard],
  );
  const prevLeaderboardPage = useCallback(() => gotoLeaderboardPage(-1), [gotoLeaderboardPage]);
  const nextLeaderboardPage = useCallback(() => gotoLeaderboardPage(1), [gotoLeaderboardPage]);

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

  /** Dismisses the web tour placeholder (ticket B10): stamps `xchief.tour_seen` with the
   * dismissal time and never shows it again on this device. Never called from kiosk mode. */
  const markTourSeen = useCallback(() => {
    if (IS_KIOSK) return;
    const iso = new Date().toISOString();
    try {
      localStorage.setItem(TOUR_SEEN_KEY, iso);
    } catch {
      /* storage unavailable: the tour will simply show again next load */
    }
    setTourSeen(iso);
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
    refreshTasks,
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
      refreshTasks();
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
    reportVideoProgress,
    startTaskVisit,
    returnTaskVisit,
    toast,
    requestOtp,
    verifyOtp,
    signOut,
    selectTournament,
    prevLeaderboardPage,
    nextLeaderboardPage,
  };

  return { state, profile, actions, trackRef, isKiosk: IS_KIOSK, tourSeen, markTourSeen };
}
