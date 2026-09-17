/**
 * The booth visitor state machine (ticket C2, docs/layers.md). Driven only by frames the server
 * sends over the socket - kiosk_session (after auth, after every settled round, after
 * kiosk_reset, and from the server's own 60 s idle sweep, server/kiosk.js) and round_settled's
 * own `coupon` field. Nothing here decides a win, a loss, or coupon eligibility; it only routes
 * the screen and runs the two purely cosmetic countdowns (the WON/BROKE modal timers and the
 * idle-countdown overlay) that the product spec calls for on top of that server state.
 *
 * Idle (ticket C2b) means no activity at all - no tap, click, pointer move, key, or touch
 * anywhere on the page - tracked with passive window listeners, at any point in the play screen
 * including mid-verdict. After IDLE_BEFORE_COUNTDOWN_MS of idle the overlay appears and counts
 * down from COUNTDOWN_MS; any activity hides it and restarts the idle window. The WON/BROKE
 * modals keep their own timers and ignore pointer activity on purpose: a winner photographing
 * the code must not keep the machine hostage by waving a hand at it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { kioskReset, onKioskSession } from './api/kiosk.js';
import { onSettled, onStatus } from './api/socket.js';

// Product defaults (docs/layers.md "Product defaults taken"): WIN modal 30 s, EXIT modal 20 s.
export const KIOSK_WON_MODAL_MS = 30000;
export const KIOSK_BROKE_MODAL_MS = 20000;
// Idle countdown (ticket C2b): 20 s of no activity shows the overlay, which then counts down
// 20 s to the flush - 40 s total. The server's own idle sweep (server/kiosk.js IDLE_MS) resets a
// session after 60 s without a round, so 20 + 20 = 40 s keeps the client's flush ahead of it and
// the two never race.
export const IDLE_BEFORE_COUNTDOWN_MS = 20000;
export const COUNTDOWN_MS = 20000;

// Runtime-configurable copies the interval below reads every tick, so the DEV-only
// window.__xchief.kioskTiming hook can shrink them for E2E tests without a rebuild.
let idleBeforeCountdownMs = IDLE_BEFORE_COUNTDOWN_MS;
let countdownMs = COUNTDOWN_MS;

if (import.meta.env.DEV) {
  const g = (window.__xchief = window.__xchief || {});
  g.kioskTiming = ({ idleMs, countdownMs: cdMs } = {}) => {
    if (typeof idleMs === 'number') idleBeforeCountdownMs = idleMs;
    if (typeof cdMs === 'number') countdownMs = cdMs;
  };
}

const TICK_MS = 250;

// Ticket B10: the kiosk intro shows once per boot, never through localStorage (the kiosk is
// anonymous by design, docs/layers.md). A module-level flag rather than component state so it
// survives every ATTRACT -> playing -> ATTRACT cycle for as long as the page stays loaded, and
// resets only on an actual reload - exactly what "per boot" means here.
let introShownThisBoot = false;

// Activity is anything a present human does anywhere on the page (ticket C2b): taps, clicks,
// pointer moves, keys, touches. Passive listeners only - the game must never feel laggy because
// the idle tracker is attached.
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'click', 'keydown', 'touchstart', 'touchmove'];

const SERVER_TO_SCREEN = { idle: 'attract', playing: 'playing', won: 'won', broke: 'broke' };

export function useKioskFlow({ onReturnToAttract } = {}) {
  const [screen, setScreen] = useState('attract');
  const [coupon, setCoupon] = useState(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [abandonSecondsLeft, setAbandonSecondsLeft] = useState(null); // null = overlay hidden
  const [modalSecondsLeft, setModalSecondsLeft] = useState(null); // WON/BROKE countdown
  const [showIntro, setShowIntro] = useState(false); // the once-per-boot placeholder (ticket B10)

  const screenRef = useRef(screen);
  screenRef.current = screen;
  const lastActivityRef = useRef(Date.now());
  const hasConnectedRef = useRef(false);
  const onReturnRef = useRef(onReturnToAttract);
  onReturnRef.current = onReturnToAttract;

  // Resets every per-visitor UI bit the moment the screen goes back to ATTRACT (docs/layers.md:
  // "clear any per-visitor UI state on every return to ATTRACT") - stable across renders so the
  // effects below can depend on it without re-subscribing.
  const goToAttract = useCallback(() => {
    setScreen('attract');
    setCoupon(null);
    setAbandonSecondsLeft(null);
    setModalSecondsLeft(null);
    lastActivityRef.current = Date.now();
    onReturnRef.current?.();
  }, []);

  // The one source of truth for which screen is showing: both round_settled and kiosk_session
  // carry the kiosk's `state` field (server/rounds.js, server/index.js), and either is enough on
  // its own to route the screen - kiosk_session is just round_settled's own mirror plus the
  // frames that have no round of their own (post-auth, kiosk_reset, the idle sweep).
  //
  // codes_left (ticket C8, docs/layers.md) overrides that mapping into a fourth screen,
  // no_codes, whenever a frame reports the pool empty - except a visitor mid-WIN, who keeps
  // the modal until they Claim (round_settled's own frame never carries codes_left, so the win
  // always applies first; its kiosk_session mirror follows a moment later and is the one this
  // exception matters for). codes_left > 0 falls straight through to the ordinary mapping,
  // which is 'idle' -> attract in the overwhelmingly common case: nobody could reach any other
  // state while the pool was empty, since no_codes hides the Play button.
  const applyServerState = useCallback(
    (state, codesLeft) => {
      if (codesLeft === 0 && state !== 'won') {
        setScreen('no_codes');
        return;
      }
      const next = SERVER_TO_SCREEN[state] || 'attract';
      if (next === 'attract') {
        if (screenRef.current !== 'attract') goToAttract();
        return;
      }
      setScreen(next);
      if (next === 'playing') lastActivityRef.current = Date.now();
    },
    [goToAttract],
  );

  useEffect(
    () => onKioskSession((session) => applyServerState(session.state, session.codes_left)),
    [applyServerState],
  );

  // round_settled carries the coupon itself and its own `state` (server/rounds.js): applying
  // both here means a synthetic round_settled alone is enough to drive WON end-to-end, without
  // waiting on its kiosk_session mirror.
  useEffect(
    () =>
      onSettled((verdict) => {
        if (verdict.coupon) setCoupon(verdict.coupon);
        if (verdict.state) applyServerState(verdict.state, verdict.codes_left);
      }),
    [applyServerState],
  );

  // "Reconnecting..." only after the socket has been up at least once - the very first connect
  // is ordinary startup, not a drop.
  useEffect(
    () =>
      onStatus((s) => {
        if (s.connected) hasConnectedRef.current = true;
        setReconnecting(hasConnectedRef.current && !s.connected);
      }),
    [],
  );

  // Any activity anywhere restarts the idle window and hides an overlay that is already showing
  // (ticket C2b). The listeners stay attached on every screen; only the PLAYING interval below
  // reads the timestamp, so activity on ATTRACT/WON/BROKE is simply never consulted.
  useEffect(() => {
    const markActivity = () => {
      lastActivityRef.current = Date.now();
      setAbandonSecondsLeft(null);
    };
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, markActivity, { passive: true });
    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, markActivity);
    };
  }, []);

  // The visible idle countdown (docs/layers.md "walks away mid-game", reworked by ticket C2b):
  // runs at any point in the play screen, mid-verdict included. At zero it flushes the session -
  // kiosk_reset to the server, then ATTRACT with the existing rise-in animation.
  useEffect(() => {
    if (screen !== 'playing') {
      setAbandonSecondsLeft(null);
      return undefined;
    }
    const id = setInterval(() => {
      const elapsed = Date.now() - lastActivityRef.current;
      if (elapsed >= idleBeforeCountdownMs + countdownMs) {
        setAbandonSecondsLeft(null);
        kioskReset();
        goToAttract();
        return;
      }
      setAbandonSecondsLeft(
        elapsed >= idleBeforeCountdownMs ? Math.ceil((idleBeforeCountdownMs + countdownMs - elapsed) / 1000) : null,
      );
    }, TICK_MS);
    return () => clearInterval(id);
  }, [screen, goToAttract]);

  // The WON/EXIT modal's own countdown; either button or zero does the same kiosk_reset.
  useEffect(() => {
    if (screen !== 'won' && screen !== 'broke') {
      setModalSecondsLeft(null);
      return undefined;
    }
    const totalMs = screen === 'won' ? KIOSK_WON_MODAL_MS : KIOSK_BROKE_MODAL_MS;
    const deadline = Date.now() + totalMs;
    setModalSecondsLeft(Math.ceil(totalMs / 1000));
    const id = setInterval(() => {
      const left = deadline - Date.now();
      if (left <= 0) {
        kioskReset();
        goToAttract();
        return;
      }
      setModalSecondsLeft(Math.ceil(left / 1000));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [screen, goToAttract]);

  return {
    screen, // 'attract' | 'playing' | 'won' | 'broke' | 'no_codes'
    coupon,
    reconnecting,
    abandonSecondsLeft, // null while hidden
    modalSecondsLeft,
    showIntro, // ticket B10: the placeholder intro, shown between ATTRACT and the first play
    /** Tap-to-play on ATTRACT: shows the once-per-boot intro first (ticket B10) instead of
     * starting PLAYING directly; dismissIntro below is what actually starts it. Every later tap
     * this boot skips straight to PLAYING. */
    startPlaying: () => {
      if (!introShownThisBoot) {
        setShowIntro(true);
        return;
      }
      setScreen('playing');
      lastActivityRef.current = Date.now();
    },
    /** The intro's single button. Counts as activity (docs/layers.md: "must not interfere with
     * the idle countdown") since it is the moment PLAYING actually starts. */
    dismissIntro: () => {
      introShownThisBoot = true;
      setShowIntro(false);
      setScreen('playing');
      lastActivityRef.current = Date.now();
    },
    /** The overlay's own tap handler; the window listeners already do this for any activity. */
    cancelAbandon: () => {
      lastActivityRef.current = Date.now();
      setAbandonSecondsLeft(null);
    },
    /** Claim (WON) / Done (BROKE): ends the session server-side and returns to ATTRACT. */
    claimOrDone: () => {
      kioskReset();
      goToAttract();
    },
  };
}
