/**
 * The booth visitor state machine (ticket C2, docs/layers.md). Driven only by frames the server
 * sends over the socket - kiosk_session (after auth, after every settled round, after
 * kiosk_reset, and from the server's own 60 s idle sweep, server/kiosk.js) and round_settled's
 * own `coupon` field. Nothing here decides a win, a loss, or coupon eligibility; it only routes
 * the screen and runs the two purely cosmetic countdowns (the WON/BROKE modal timers and the
 * abandon-warning overlay) that the product spec calls for on top of that server state.
 *
 * `gamePhase` is useGame.js's own state.phase ('idle'|'running'|'result'): the abandon countdown
 * (docs/layers.md "walks away mid-game") only starts once a round is not in flight, and any new
 * round attempt cancels it, so this hook is told whenever a round starts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { kioskReset, onKioskSession } from './api/kiosk.js';
import { onSettled, onStatus } from './api/socket.js';

// Product defaults (docs/layers.md "Product defaults taken"): WIN modal 30 s, EXIT modal 20 s,
// abandon countdown shows after 30 s idle and flushes at 60 s total - matching the server's own
// 60 s kiosk idle sweep (server/kiosk.js IDLE_MS) so the client's own flush never fights it.
export const KIOSK_WON_MODAL_MS = 30000;
export const KIOSK_BROKE_MODAL_MS = 20000;
export const KIOSK_ABANDON_SHOW_MS = 30000;
export const KIOSK_ABANDON_FLUSH_MS = 60000;

const TICK_MS = 250;

const SERVER_TO_SCREEN = { idle: 'attract', playing: 'playing', won: 'won', broke: 'broke' };

export function useKioskFlow(gamePhase, { onReturnToAttract } = {}) {
  const [screen, setScreen] = useState('attract');
  const [coupon, setCoupon] = useState(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [abandonSecondsLeft, setAbandonSecondsLeft] = useState(null); // null = overlay hidden
  const [modalSecondsLeft, setModalSecondsLeft] = useState(null); // WON/BROKE countdown

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
  const applyServerState = useCallback(
    (state) => {
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

  useEffect(() => onKioskSession((session) => applyServerState(session.state)), [applyServerState]);

  // round_settled carries the coupon itself and its own `state` (server/rounds.js): applying
  // both here means a synthetic round_settled alone is enough to drive WON end-to-end, without
  // waiting on its kiosk_session mirror.
  useEffect(
    () =>
      onSettled((verdict) => {
        if (verdict.coupon) setCoupon(verdict.coupon);
        if (verdict.state) applyServerState(verdict.state);
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

  // A new round attempt is activity: cancel any abandon warning in progress.
  useEffect(() => {
    if (gamePhase === 'running') lastActivityRef.current = Date.now();
  }, [gamePhase]);

  // The visible abandon countdown (docs/layers.md "walks away mid-game"): only while PLAYING and
  // no round in flight. Flushes itself at KIOSK_ABANDON_FLUSH_MS, same threshold the server's own
  // idle sweep uses, so the two never race for long.
  useEffect(() => {
    if (screen !== 'playing') {
      setAbandonSecondsLeft(null);
      return undefined;
    }
    const id = setInterval(() => {
      if (gamePhase === 'running') {
        setAbandonSecondsLeft(null);
        return;
      }
      const elapsed = Date.now() - lastActivityRef.current;
      if (elapsed >= KIOSK_ABANDON_FLUSH_MS) {
        setAbandonSecondsLeft(null);
        kioskReset();
        goToAttract();
        return;
      }
      setAbandonSecondsLeft(
        elapsed >= KIOSK_ABANDON_SHOW_MS ? Math.ceil((KIOSK_ABANDON_FLUSH_MS - elapsed) / 1000) : null,
      );
    }, TICK_MS);
    return () => clearInterval(id);
  }, [screen, gamePhase, goToAttract]);

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
    screen, // 'attract' | 'playing' | 'won' | 'broke'
    coupon,
    reconnecting,
    abandonSecondsLeft, // null while hidden
    modalSecondsLeft,
    /** Tap-to-play on ATTRACT: purely local - the session itself only starts on the first `play`. */
    startPlaying: () => {
      setScreen('playing');
      lastActivityRef.current = Date.now();
    },
    /** Any tap during the abandon countdown cancels it. */
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
