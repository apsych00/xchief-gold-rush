import { useCallback, useEffect, useRef, useState } from 'react';
import { comboMult, ECON } from './config.js';
import { startPriceFeed } from './priceFeed.js';
import { loadProfile, resetProfile as wipeProfile, saveProfile } from './profile.js';
import { enabled as apiEnabled } from './api/client.js';
import * as api from './api/game.js';
import { ensureSession, requestOtp as sessionRequestOtp, signOut as sessionSignOut, verifyOtp as sessionVerifyOtp } from './api/session.js';
import { IS_KIOSK, playKioskRound } from './api/kiosk.js';
import {
  connect as connectSocket,
  getInstagramHandle,
  onIdentityChange,
  onKioskSession,
  onLeaderboard,
  onSettled,
} from './api/socket.js';
import { SCREEN_PATHS, useUrlRouting } from './useUrlRouting.js';

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
  // OTHERS is the static demo list, only meaningful on the no-server preview path
  // (apiEnabled === false). When apiEnabled, this stays null until the leaderboard's first
  // fetch or push lands - null means "no data yet" (renders a skeleton), [] means "loaded and
  // empty" (renders the real empty/guest state). See Leaderboard in src/App.jsx.
  others: apiEnabled ? null : OTHERS,
  // Tournament header and switcher list (ticket B1): null/[] until the leaderboard screen's
  // first fetch or push. `tournament` is null while no tournament is running.
  tournament: null,
  tournaments: [],
  // Paging and the player's own row (ticket B2). Rows accumulate as the player scrolls
  // (infinite scroll): `page` is the highest page merged into `others` so far, `pages` the
  // board's total page count, `total` its total ranked-player count. `me` is this player's own
  // row from public.my_rank() - matched by player id, never a masked-email string (closes gap
  // G3) - or null for a guest/unverified player. `legend` (ticket B3) is set once from whichever
  // request reply carried it and kept across the unsolicited live push, which never carries one.
  page: 1,
  pages: 1,
  total: 0,
  me: null,
  legend: [],
  // True while a scroll-triggered next-page fetch is in flight (src/App.jsx's Leaderboard shows
  // a couple of skeleton rows at the end of the list while this is true).
  lbLoadingMore: false,
  feed: { mode: 'connecting', source: null, symbol: null, quiet: false, connectionRefused: false },
  // last settled round
  result: null, // { outcome:'win'|'lose'|'flat', stake, delta, mult, streak, badge, coupon? }
  toast: null, // { id, text } transient notice
  // Task definitions plus this player's own claimed state, computed server-side by
  // public.get_tasks() (docs/layers.md C5; ticket B6+B7+B9 decision 1). Empty until the first
  // fetch; kiosk and offline (apiEnabled false) modes never populate it - there is no local
  // fallback any more, the client keeps no task table of its own.
  tasksRows: [],
  // Ticket K3: the Instagram account to follow, from the server's welcome (INSTAGRAM_HANDLE).
  // null until the session is up; the tasks UI falls back to a default until then.
  ourInstagramHandle: null,
  // True once this session's own `me` row has landed from the server (applyMe below) - the
  // app's only proof of who the player is. Deliberately transient state, never persisted on
  // the profile object: every page load starts at false ("unknown"), and every email-ask
  // guard (src/leads.js's mayAskEmail) treats unknown as "do not ask", so a verified user
  // reconnecting - or deep-linking straight to /board - can never be prompted during the
  // connect window, whatever localStorage happens to say.
  identityKnown: false,
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
  // Set once the `actions` object below exists (synchronously, during this same render, same
  // pattern as stateRef/profileRef above) - the routing hook's boot/popstate effect reads it
  // through this ref rather than depending on `actions` directly, since actions is a fresh object
  // literal every render.
  const actionsRef = useRef(null);
  // Guards every navigation away from a live round (ticket: nav-on-play). `pendingNav` holds the
  // navigation to run once the player confirms, or null when nothing is waiting - App.jsx renders
  // the confirmation modal exactly while it is set. A ref mirrors it (same reasoning as
  // profileRef/phaseRef above) so confirmNav/cancelNav read the queued function directly instead
  // of through a state updater, which StrictMode's double-invoke would otherwise run twice.
  const [pendingNav, setPendingNav] = useState(null);
  const pendingNavRef = useRef(null);
  // `onQueued` fires synchronously, before the confirmation shows, only when this call is the one
  // that queues rather than runs immediately - useUrlRouting's popstate handler uses it to put the
  // address bar back where the app still is, since the browser has already moved it by the time
  // popstate fires.
  const requestNav = useCallback((fn, onQueued) => {
    if (phaseRef.current === 'running') {
      onQueued?.();
      pendingNavRef.current = fn;
      // The functional form: setPendingNav(fn) would have React treat fn itself as the state
      // updater, calling it with the previous state and running the navigation immediately -
      // exactly what this guard exists to stop.
      setPendingNav(() => fn);
    } else {
      fn();
    }
  }, []);
  const confirmNav = useCallback(() => {
    const fn = pendingNavRef.current;
    pendingNavRef.current = null;
    setPendingNav(null);
    fn?.();
  }, []);
  const cancelNav = useCallback(() => {
    pendingNavRef.current = null;
    setPendingNav(null);
  }, []);
  const requestNavRef = useRef(requestNav);
  requestNavRef.current = requestNav;
  const { pushPath } = useUrlRouting(actionsRef, IS_KIOSK, requestNavRef);
  // React StrictMode's dev-only double-invoke runs the hydrate effect below twice on mount;
  // ensureSession() is already single-flight for that (src/api/session.js), but the getMe/
  // refreshTasks chain after it is not - this keeps that one-time bootstrap to a single run so it
  // cannot send the same query type twice within the server's 1/s per-socket budget (a real,
  // reproducible flakiness: a stray rate_limited error frame for either call, thanks to
  // socket.js's settlePending matching any error to the oldest pending request, can reject a
  // totally unrelated in-flight request - e.g. a deep-link boot's own leaderboard/tasks fetch).
  const hydratedRef = useRef(false);

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
  // uses it (ticket B2 decision 1, closes gap G3): see applyLeaderboardReplace below.
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
    // The server has now told this session who the player is, so the email guards
    // (src/leads.js's mayAskEmail) may act from here on. Every `me`-shaped reply counts -
    // the bootstrap get_me, a re-login's identity change, a claim/reward reply - they all
    // carry the same authoritative row.
    setState((s) => (s.identityKnown ? s : { ...s, identityKnown: true }));
    return next;
  }, []);

  // Score-desync fix: the one place that flips a tasksRows entry to claimed. Every reward path
  // that tells the client exactly which task it just released (claim_task, task_progress,
  // task_return, instagram_check) goes through this instead of each writing its own copy of the
  // same tasksRows.map() - one path for this piece of state, same reasoning as applyMe above for
  // coins/record/streak. verify_otp's email/signup grant has no single task id to pass here (it
  // can release two at once and, on a re-login, none) - refreshTasks() covers that one instead.
  const markTaskClaimed = useCallback((taskId) => {
    setState((s) => ({
      ...s,
      tasksRows: s.tasksRows.map((r) => (r.id === taskId ? { ...r, claimed: true } : r)),
    }));
  }, []);

  // Applies one `leaderboard`-shaped frame (ticket B2) as a fresh board: used for the first
  // fetch when the screen mounts and whenever the player switches tournament (ticket B1) -
  // both replace every accumulated row rather than appending to it. `rows` are already ranked
  // and tiered server-side; `me` is this player's own row from public.my_rank(), matched by
  // player id, or null for a guest/unverified player - never a masked-email string comparison
  // (closes gap G3). `legend` (ticket B3) only ever arrives on a direct request.
  const applyLeaderboardReplace = useCallback((payload) => {
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

  // Applies one more page fetched by infinite scroll (src/App.jsx's Leaderboard sentinel):
  // appends its rows to whatever is already accumulated instead of replacing them. Same frame
  // shape as applyLeaderboardReplace above; `me`/`legend`/`tournament` are re-applied too since
  // every reply carries them regardless of page, and they never disagree between pages of the
  // same board.
  const applyLeaderboardAppend = useCallback((payload) => {
    const { rows, tournament, tournaments, page, pages, total, me, legend } = payload;
    setState((s) => ({
      ...s,
      others: [...(s.others || []), ...rows],
      tournament,
      tournaments,
      page: page ?? s.page,
      pages: pages ?? s.pages,
      total: total ?? s.total,
      me: me ?? null,
      legend: legend ?? s.legend,
    }));
  }, []);

  // Merges the unsolicited live push (docs/layers.md C4) - which always carries page 1 of the
  // currently running tournament - over the first LEADERBOARD_PAGE_SIZE accumulated rows,
  // keeping whatever else infinite scroll has loaded rather than truncating it back to one
  // page. Switching tournaments (the pushed board's id differs from what is on screen) still
  // resets to that single fresh page, same as picking a different board from the switcher.
  //
  // src/api/socket.js emits every `leaderboard` frame here unconditionally - both a genuine
  // push AND the direct reply to this socket's own getLeaderboard() request, which
  // applyLeaderboardAppend/applyLeaderboardReplace already apply through that request's own
  // settled promise. A push is always page 1; a page 2+ frame reaching here can only be a
  // paged reply, and merging it as though it were a fresh page 1 would prepend that later page
  // over the front of the board and drop whatever was already there. Skipping anything that
  // is not page 1 leaves paged replies to their own, single application.
  const applyLeaderboardPush = useCallback((payload) => {
    if (payload.page !== 1) return;
    const { rows, tournament, tournaments, pages, total, me, legend } = payload;
    setState((s) => {
      const tournamentChanged = (s.tournament?.id ?? null) !== (tournament?.id ?? null);
      const others = tournamentChanged ? rows : [...rows, ...(s.others || []).slice(rows.length)];
      return {
        ...s,
        others,
        tournament,
        tournaments,
        page: tournamentChanged ? 1 : s.page,
        pages: pages ?? s.pages,
        total: total ?? s.total,
        me: me ?? null,
        legend: legend ?? s.legend,
      };
    });
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
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      ensureSession()
        .then(() => {
          // Ticket K3: the welcome that ensureSession waited on carries the handle to follow.
          setState((s) => ({ ...s, ourInstagramHandle: getInstagramHandle() }));
          return api.getMe();
        })
        .then(applyMe)
        .then(() => refreshTasks())
        .catch((err) => {
          console.error('[api] session bootstrap failed', err);
        });
    }
    const offIdentityChange = onIdentityChange(guardedApplyMe);
    return () => {
      cancelled = true;
      offIdentityChange();
    };
  }, [applyMe, refreshTasks]);

  // Live, masked leaderboard (docs/layers.md C4, ticket B2): every push shares the request
  // reply's frame shape, but is merged rather than replacing everything infinite scroll has
  // accumulated - see applyLeaderboardPush above.
  useEffect(() => {
    if (!apiEnabled || IS_KIOSK) return undefined;
    return onLeaderboard(applyLeaderboardPush);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kiosk balance sync: the server pushes a fresh kiosk_session after auth, after every settled
  // round, after kiosk_reset, and from its own idle sweep. In kiosk mode this is the one source
  // of truth for coins and streak; trusting it here keeps the header balance from showing the
  // previous visitor's pot when the screen returns to ATTRACT (docs/layers.md C2).
  useEffect(() => {
    if (!apiEnabled || !IS_KIOSK) return undefined;
    return onKioskSession((session) => {
      const p = profileRef.current;
      const next = {
        ...p,
        coins: session.coins,
        streak: session.streak,
        record: Math.max(p.record, session.coins),
        bestStreak: Math.max(p.bestStreak, session.streak),
      };
      profileRef.current = next;
      setProfile(next);
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
      // A round only ever starts from 'idle', on the kiosk exactly as on the web: the up/down
      // buttons stay locked through the running and result phases, and the explicit Play Again
      // tap in the result pane is what resets the phase back to 'idle' before the next round.
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

  // Ticket resume-round: the server keeps a round running and paying out whether or not any
  // client is watching (AGENTS.md's "server owns the round"), so leaving the play screen mid-
  // round must not touch this round's own state - the countdown timer above already tracks real
  // wall-clock time via performance.now(), so simply leaving it alone is what lets a return to
  // the play screen show the same round still in progress, and what lets the onSettled effect
  // (which checks phaseRef.current === 'running') deliver the result normally instead of
  // silently. Only an idle or already-settled round is safe to clear on the way to another
  // screen, exactly as before.
  const leaveGameState = () => {
    if (phaseRef.current === 'running') return {};
    stopTimer();
    return reset;
  };

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
          markTaskClaimed(res.task);
          toast(`+${res.reward}`);
        })
        .catch((err) => toast(err?.code || 'error'));
      return true;
    },
    [applyMe, markTaskClaimed, toast],
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
            markTaskClaimed(taskId);
            toast(`+${res.reward}`);
          }
        })
        .catch((err) => console.error('[api] task_progress failed', err));
    },
    [applyMe, markTaskClaimed, toast],
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
        markTaskClaimed(taskId);
        toast(`+${res.reward}`);
        return res;
      });
    },
    [applyMe, markTaskClaimed, toast],
  );

  // Instagram follow reward, step 1 (ticket K3): store the handle and get the follow URLs back.
  // The client never asserts the follow - it just opens Instagram; the server decides in step 2.
  const instagramStart = useCallback((handle) => {
    if (!apiEnabled || IS_KIOSK)
      return Promise.reject(Object.assign(new Error('not_available'), { code: 'not_available' }));
    return api.instagramStart(handle);
  }, []);

  // Instagram follow reward, step 2 (ticket K3): ask the server to read BoxAPI and decide. On a
  // proven follow the server has already released the reward; reflect the fresh coins and the
  // claimed row here, exactly like the other reward paths. The reason on a refusal is left to the
  // Tasks screen to phrase.
  const instagramCheck = useCallback(() => {
    if (!apiEnabled || IS_KIOSK)
      return Promise.reject(Object.assign(new Error('not_available'), { code: 'not_available' }));
    return api.instagramCheck().then((res) => {
      if (res.ok) {
        if (res.me) applyMe(res.me);
        markTaskClaimed('instagram');
        if (res.reward != null) toast(`+${res.reward}`);
      }
      return res;
    });
  }, [applyMe, markTaskClaimed, toast]);

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

  /** Fetches page 1 of a board and replaces whatever is accumulated - the leaderboard screen's
   * initial load and every tournament switch land here. */
  const fetchLeaderboard = useCallback((tournament, page) => {
    if (!apiEnabled || IS_KIOSK) return;
    api
      .getLeaderboard({ tournament, page })
      .then(applyLeaderboardReplace)
      .catch((err) => console.error('[api] leaderboard fetch failed', err));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshLeaderboard = useCallback(() => fetchLeaderboard(null, 1), [fetchLeaderboard]);

  /** Switches the leaderboard screen to a specific tournament's own board - past or upcoming
   * (ticket B1's switcher), reset to page 1. `null` goes back to whichever tournament is
   * currently running. */
  const selectTournament = useCallback((id) => fetchLeaderboard(id, 1), [fetchLeaderboard]);

  // Never two loads in flight at once (checked synchronously, a ref rather than state so a
  // second IntersectionObserver callback firing before the first setState lands still sees it).
  const lbLoadingRef = useRef(false);

  /** Infinite scroll (replaces the old Prev/Next pager, ticket B2 decision 4): fetches the next
   * page of whichever tournament is currently on screen (state.tournament?.id - `null` once no
   * tournament is running or none was ever fetched, which already means "whichever is current"
   * to the server) and appends it. No-op when a load is already in flight or every page is
   * already loaded (state.page >= state.pages). A failed fetch clears the in-flight flag so the
   * next scroll (or the same one, if the sentinel is still visible) can retry - it never wedges
   * the list. */
  const loadMoreLeaderboard = useCallback(() => {
    if (!apiEnabled || IS_KIOSK) return;
    const s = stateRef.current;
    if (lbLoadingRef.current) return;
    if ((s.page || 1) >= (s.pages || 1)) return;
    const nextPage = (s.page || 1) + 1;
    lbLoadingRef.current = true;
    setState((st) => ({ ...st, lbLoadingMore: true }));
    api
      .getLeaderboard({ tournament: s.tournament ? s.tournament.id : null, page: nextPage })
      .then(applyLeaderboardAppend)
      .catch((err) => console.error('[api] leaderboard load-more failed', err))
      .finally(() => {
        lbLoadingRef.current = false;
        setState((st) => ({ ...st, lbLoadingMore: false }));
      });
  }, [applyLeaderboardAppend]);

  /** Requests a login code for `email` (docs/layers.md C3; length is src/config.js's
   * OTP_CODE_LENGTH). */
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
   * the screen and came back. A verify is rare enough that one extra fetch here is free.
   *
   * Score-desync fix: this is also the one reward path whose server reply carries no task id
   * (verify_otp_code can release the email task and, on a first verify, the signup task too, in
   * one call - server/index.js's verify_otp), so markTaskClaimed above has nothing to key off.
   * refreshTasks() re-pulls the real claimed state from the server instead, the same "one extra
   * fetch is free" reasoning as refreshLeaderboard() just above - without it the Missions screen
   * would keep showing "Start" on a task the server already paid out until its own 5 s poll (or
   * the player leaving and coming back) caught up. */
  const verifyOtp = useCallback(
    (email, code) =>
      sessionVerifyOtp(email, code).then((me) => {
        const next = applyMe(me);
        refreshLeaderboard();
        refreshTasks();
        return { ...next, identityChanged: !!me.token };
      }),
    [applyMe, refreshLeaderboard, refreshTasks],
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
    startGame: () => {
      patch({ screen: 'game' });
      pushPath(SCREEN_PATHS.game);
    },
    goHome: () => {
      patch({ screen: 'home', ...leaveGameState() });
      pushPath(SCREEN_PATHS.home);
    },
    goLeaderboard: () => {
      refreshLeaderboard();
      patch({ screen: 'lb' });
      pushPath(SCREEN_PATHS.lb);
    },
    goProfile: () => {
      patch({ screen: 'profile', ...leaveGameState() });
      pushPath(SCREEN_PATHS.profile);
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
      refreshTasks();
      patch({ screen: 'tasks', ...leaveGameState() });
      pushPath(SCREEN_PATHS.tasks);
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
    instagramStart,
    instagramCheck,
    toast,
    requestOtp,
    verifyOtp,
    signOut,
    selectTournament,
    loadMoreLeaderboard,
  };
  actionsRef.current = actions;

  return {
    state,
    profile,
    actions,
    trackRef,
    isKiosk: IS_KIOSK,
    tourSeen,
    markTourSeen,
    requestNav,
    pendingNav,
    confirmNav,
    cancelNav,
  };
}
