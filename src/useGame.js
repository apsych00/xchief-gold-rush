import { useCallback, useEffect, useRef, useState } from 'react';
import { startPriceFeed } from './priceFeed.js';

export const BASE_POINTS = 100;
export const ROUND_SECONDS = 5;
export const LEVERS = [1, 2, 5];
const TICK_MS = 60;
const MAX_HISTORY = 90;

const OTHERS = [
  { name: 'GoldHunter', s: 3600 },
  { name: 'Alpha', s: 3200 },
  { name: 'GoldPilot', s: 2800 },
  { name: 'Nova', s: 2700 },
  { name: 'Titan', s: 2650 },
  { name: 'Rex', s: 2550 },
  { name: 'Mira', s: 2480 },
];

const initialState = {
  screen: 'home', // 'home' | 'game' | 'lb'
  phase: 'idle', // 'idle' | 'running' | 'result'
  lev: 1,
  dir: null, // 'up' | 'down' | null
  balance: 2400,
  price: null, // latest market price, null until the feed delivers
  start: null, // price locked at the start of the round
  end: null, // price the round settled on (frozen, unlike `price`)
  remaining: ROUND_SECONDS,
  history: [],
  win: false,
  tie: false,
  points: 0,
  drag: false,
  others: OTHERS,
  feed: { mode: 'connecting', source: null }, // connecting | live | poll | demo
};

export function useGame() {
  const [state, setState] = useState(initialState);
  const timer = useRef(null);
  const phaseRef = useRef(state.phase);
  const dragRef = useRef(false);
  const priceRef = useRef(null);
  const trackRef = useRef(null);

  phaseRef.current = state.phase;

  const stopTimer = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  const patch = useCallback((p) => setState((s) => ({ ...s, ...p })), []);

  // Live price feed: keeps priceRef fresh and mirrors it into state.
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
    };
  }, [stopTimer]);

  const startRound = useCallback(
    (dir) => {
      if (phaseRef.current !== 'idle') return;
      const start = priceRef.current;
      if (start == null) return; // no market price yet
      phaseRef.current = 'running';
      stopTimer();

      const t0 = performance.now();
      patch({ dir, phase: 'running', start, remaining: ROUND_SECONDS, history: [start], win: false, tie: false });

      timer.current = setInterval(() => {
        const elapsed = (performance.now() - t0) / 1000;
        const price = priceRef.current ?? start;
        if (elapsed >= ROUND_SECONDS) {
          stopTimer();
          setState((cur) => {
            const tie = price === cur.start;
            const win = !tie && (dir === 'up') === price > cur.start;
            const points = win ? BASE_POINTS * cur.lev : 0;
            return {
              ...cur,
              phase: 'result',
              price,
              end: price,
              remaining: 0,
              win,
              tie,
              points,
              balance: cur.balance + points,
              history: [...cur.history, price],
            };
          });
          return;
        }
        // Sample the latest price on every tick so the chart moves smoothly
        // even when the market only ticks a few times per second.
        setState((cur) => ({
          ...cur,
          remaining: ROUND_SECONDS - elapsed,
          history: [...cur.history, price].slice(-MAX_HISTORY),
        }));
      }, TICK_MS);
    },
    [patch, stopTimer],
  );

  const setLevFromEvent = useCallback(
    (e) => {
      const el = trackRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const p = 1 - Math.min(1, Math.max(0, (e.clientY - r.top - 18) / (r.height - 36)));
      patch({ lev: p < 0.3 ? 1 : p < 0.75 ? 2 : 5 });
    },
    [patch],
  );

  const reset = { phase: 'idle', dir: null, start: null, end: null, history: [], win: false, tie: false };

  const actions = {
    startGame: () => patch({ screen: 'game' }),
    goHome: () => {
      stopTimer();
      patch({ screen: 'home', ...reset });
    },
    goLeaderboard: () => patch({ screen: 'lb' }),
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
      if (phaseRef.current === 'idle' && LEVERS.includes(lev)) patch({ lev });
    },
  };

  return { state, actions, trackRef };
}
