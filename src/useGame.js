import { useCallback, useEffect, useRef, useState } from 'react';

export const BASE_POINTS = 100;
export const ROUND_SECONDS = 5;
export const START_PRICE = 2500;
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
  price: START_PRICE,
  start: START_PRICE,
  remaining: ROUND_SECONDS,
  history: [],
  win: false,
  points: 0,
  drag: false,
  others: OTHERS,
};

/** Random-walk tick for the simulated XAUUSD price, clamped to ±1 around the start. */
function nextPrice(p) {
  const step = (Math.random() - 0.5) * 0.09 + (Math.random() - 0.5) * 0.02;
  return Math.max(START_PRICE - 1, Math.min(START_PRICE + 1, p + step));
}

export function useGame() {
  const [state, setState] = useState(initialState);
  const timer = useRef(null);
  const phaseRef = useRef(state.phase);
  const dragRef = useRef(false);
  const trackRef = useRef(null);

  phaseRef.current = state.phase;

  const stopTimer = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => stopTimer, [stopTimer]);

  const patch = useCallback((p) => setState((s) => ({ ...s, ...p })), []);

  const startRound = useCallback(
    (dir) => {
      if (phaseRef.current !== 'idle') return;
      phaseRef.current = 'running';
      stopTimer();

      const t0 = performance.now();
      let price = START_PRICE;
      patch({
        dir,
        phase: 'running',
        start: START_PRICE,
        price,
        remaining: ROUND_SECONDS,
        history: [START_PRICE],
      });

      timer.current = setInterval(() => {
        const elapsed = (performance.now() - t0) / 1000;
        price = nextPrice(price);
        if (elapsed >= ROUND_SECONDS) {
          stopTimer();
          setState((cur) => {
            const wentUp = price >= cur.start;
            const win = (dir === 'up') === wentUp && price !== cur.start;
            const points = win ? BASE_POINTS * cur.lev : 0;
            return {
              ...cur,
              phase: 'result',
              price,
              remaining: 0,
              win,
              points,
              balance: cur.balance + points,
              history: [...cur.history, price],
            };
          });
          return;
        }
        setState((cur) => ({
          ...cur,
          price,
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

  const actions = {
    startGame: () => patch({ screen: 'game' }),
    goHome: () => {
      stopTimer();
      patch({ screen: 'home', phase: 'idle', dir: null, price: START_PRICE, history: [] });
    },
    goLeaderboard: () => patch({ screen: 'lb' }),
    playAgain: () => patch({ phase: 'idle', dir: null, price: START_PRICE, history: [] }),
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
