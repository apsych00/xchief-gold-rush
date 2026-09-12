import { fa, money } from './format.js';
import { BASE_POINTS, useGame } from './useGame.js';

const GREEN = '#35E36F';
const GOLD = '#E9B62A';
const RED = '#FF5C5C';
const DIM = 'rgba(255,255,255,.55)';

// 11×10 pixel-art coin shown on a win. A = gold, B = dark, . = transparent.
const COIN_MAP = [
  '..AAAAAAA..',
  '.AAAAAAAAA.',
  'AAAAAAAAAAA',
  'ABBBBABBBBA',
  'ABBBBABBBBA',
  'AAAAAAAAAAA',
  'AAAAAAAAAAA',
  'AABAAAAABAA',
  '.AABBBBBAA.',
  '..AAAAAAA..',
];
const COIN_PX = COIN_MAP.flatMap((row, r) =>
  row.split('').map((c, i) => {
    if (c === '.') return 'transparent';
    if (c === 'A') return r < 2 || (i + r) % 5 === 0 ? '#FFD75E' : GOLD;
    return '#151515';
  }),
);

const KNOB_TOP = { 1: 134, 2: 67, 5: 0 };

function TrophyIcon({ stroke }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.7V17c0 .6-.4 1-1 1.3L7 20h10l-2-1.7c-.6-.3-1-.7-1-1.3v-2.3M18 2H6v7a6 6 0 0 0 12 0V2z" />
    </svg>
  );
}

function HomeIcon({ stroke }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function GamepadIcon({ stroke }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 11h4M8 9v4M15 12h.01M18 10h.01M17.3 5H6.7a4 4 0 0 0-4 3.6L2 15.6A2.4 2.4 0 0 0 6.2 17.5l1.6-2h8.4l1.6 2a2.4 2.4 0 0 0 4.2-1.9l-.7-7A4 4 0 0 0 17.3 5z" />
    </svg>
  );
}

function TopBar({ balance }) {
  return (
    <header className="topbar">
      <div className="logo" dir="ltr">
        <span className="logo-x">x</span>Chief
      </div>
      <div className="balance-chip">
        <span className="coin-dot" />
        <span className="balance-text">{fa(balance)} امتیاز</span>
      </div>
    </header>
  );
}

function Home({ onStart }) {
  return (
    <section className="home">
      <div className="home-question">۵ ثانیه بعد، طلا بالاتر می‌ره یا پایین‌تر؟</div>
      <div className="hero">
        <div className="hero-ring" />
        <div className="hero-glow" />
        <div className="bar">
          <div className="bar-body" />
          <div className="bar-top" />
          <div className="bar-label" dir="ltr">GOLD 999.9</div>
        </div>
      </div>
      <div className="home-cta">
        <button type="button" className="btn-start" onClick={onStart}>
          شروع چالش
        </button>
        <div className="home-note">امتیاز پایه هر برد: {fa(BASE_POINTS)} × اهرم</div>
      </div>
    </section>
  );
}

function Chart({ history, start, color }) {
  const h = history.length ? history : [start];
  const mn = Math.min(...h, start) - 0.05;
  const mx = Math.max(...h, start) + 0.05;
  const pts = h
    .map((v, i) => `${(i / Math.max(1, h.length - 1)) * 300},${80 - ((v - mn) / (mx - mn)) * 80}`)
    .join(' ');
  return (
    <svg viewBox="0 0 300 80" className="chart">
      <line x1="0" y1="40" x2="300" y2="40" stroke="rgba(255,255,255,.25)" strokeDasharray="4 6" strokeWidth="1.5" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Display({ state, actions }) {
  const { phase, price, start, lev, dir, remaining, history, win, points } = state;
  const isIdle = phase === 'idle';
  const isRunning = phase === 'running';
  const isResult = phase === 'result';
  const delta = price - start;
  const up = delta >= 0;
  const deltaColor = up ? GREEN : RED;
  const digit = isRunning ? Math.max(1, Math.ceil(remaining)) : 0;

  return (
    <div className="display">
      <div className="display-inner">
        <div className="display-rays" />
        <div className="display-vignette" />
        <button type="button" className="btn-home" onClick={actions.goHome}>
          → خانه
        </button>

        {isIdle && (
          <div className="pane pane-idle">
            <div className="ticker" dir="ltr">GOLD · XAUUSD</div>
            <div className="price-big" dir="ltr">{money(price)}</div>
            <div style={{ height: 18 }} />
            <div className="idle-title">۵ ثانیه بعد؟</div>
            <div className="idle-help">اهرم رو با اسلایدر انتخاب کن، بعد جهت رو بزن</div>
            <div className="lev-pill">
              اهرم امتیاز{' '}
              <span dir="ltr" className="lev-pill-x">×{lev}</span>
              {' '}· برد = <span>{fa(BASE_POINTS * lev)}</span> امتیاز
            </div>
          </div>
        )}

        {isRunning && (
          <div className="pane pane-running">
            <div className="ticker ticker-sm" dir="ltr">GOLD · XAUUSD</div>
            <div className="price-row" dir="ltr">
              <span className="price-mid">{money(price)}</span>
              <span className="price-delta" style={{ color: deltaColor }}>
                {(up ? '▲ +' : '▼ ') + delta.toFixed(2)}
              </span>
            </div>
            <Chart history={history} start={start} color={deltaColor} />
            <div key={digit} className="countdown" dir="ltr">{digit}</div>
            <div className="locked-note">
              پیش‌بینی قفل شد · {dir === 'up' ? 'صعود ▲' : 'نزول ▼'} · اهرم <span dir="ltr">×{lev}</span>
            </div>
          </div>
        )}

        {isResult && (
          <div className="pane pane-result">
            {win ? (
              <>
                <div className="coin-grid">
                  {COIN_PX.map((c, i) => (
                    <div key={i} style={{ background: c }} />
                  ))}
                </div>
                <div className="win-row" dir="ltr">
                  <span className="win-word">WIN</span>
                  <span className="win-mult">×{lev}</span>
                </div>
                <div className="result-line result-line-1">درست پیش‌بینی کردی!</div>
                <div className="result-points">{fa(points)}+ امتیاز</div>
                <div className="result-sub">{fa(BASE_POINTS)} امتیاز پایه × {fa(lev)}</div>
              </>
            ) : (
              <>
                <div className="miss-word" dir="ltr">MISS</div>
                <div className="result-line miss-line">این بار نشد؛ دوباره پیش‌بینی کن</div>
                <div className="result-sub miss-sub">امتیازی کسر نمی‌شود</div>
              </>
            )}
            <div className="result-stats">
              <div className="stat">
                <span className="stat-label">قیمت شروع</span>
                <span className="stat-val" dir="ltr">{money(start)}</span>
              </div>
              <div className="stat">
                <span className="stat-label">قیمت پایان</span>
                <span className="stat-val stat-val-gold" dir="ltr">{money(price)}</span>
              </div>
            </div>
            <div className="result-actions">
              <button type="button" className="btn-again" onClick={actions.playAgain}>
                دور بعدی
              </button>
              <button type="button" className="btn-lb" onClick={actions.goLeaderboard}>
                لیدربورد
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Console({ state, actions, trackRef }) {
  const { phase, lev, dir, win, balance } = state;
  const isIdle = phase === 'idle';
  const isRunning = phase === 'running';
  const isResult = phase === 'result';
  const locked = !isIdle;
  const onGold = !isResult;

  const bodyClass = isResult ? (win ? 'body body-win' : 'body body-lose') : 'body body-gold';
  const levLabelColor = onGold ? (lev === 5 ? '#fff' : 'rgba(0,0,0,.7)') : '#fff';
  const tickColor = (m) => (lev === m ? '#fff' : onGold ? 'rgba(0,0,0,.5)' : 'rgba(255,255,255,.4)');

  let hint;
  if (isIdle) hint = 'اهرم رو بکش، بعد جهت رو انتخاب کن';
  else if (isRunning) hint = 'انتخاب تا پایان دور قفل شد';
  else if (win) hint = `موجودی: ${fa(balance)} امتیاز`;
  else hint = 'دور بعدی رو شروع کن';

  return (
    <section className="console">
      <Display state={state} actions={actions} />

      <div className={bodyClass}>
        <div className="body-sheen" />
        <div className="lev-label" style={{ color: levLabelColor }}>
          <span>اهرم امتیاز</span>
          <span className="lev-label-x" dir="ltr">×{lev}</span>
          <span className="lev-lock" style={{ opacity: locked ? 1 : 0 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z" />
            </svg>
          </span>
        </div>

        <div
          ref={trackRef}
          className="slider"
          role="slider"
          aria-label="اهرم امتیاز"
          aria-valuemin={1}
          aria-valuemax={5}
          aria-valuenow={lev}
          aria-disabled={locked}
          tabIndex={0}
          onPointerDown={actions.sliderDown}
          onPointerMove={actions.sliderMove}
          onPointerUp={actions.sliderUp}
          onPointerCancel={actions.sliderUp}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') actions.setLev(lev === 1 ? 2 : 5);
            else if (e.key === 'ArrowDown') actions.setLev(lev === 5 ? 2 : 1);
          }}
        >
          <div className="slider-track" />
          <div className="slider-knob" style={{ top: KNOB_TOP[lev] }} />
        </div>
        <div className="tick tick-5" dir="ltr" style={{ color: tickColor(5) }} onClick={() => actions.setLev(5)}>— ×5</div>
        <div className="tick tick-2" dir="ltr" style={{ color: tickColor(2) }} onClick={() => actions.setLev(2)}>— ×2</div>
        <div className="tick tick-1" dir="ltr" style={{ color: tickColor(1) }} onClick={() => actions.setLev(1)}>— ×1</div>

        <button
          type="button"
          className="btn-dir btn-down"
          onClick={actions.pickDown}
          disabled={locked}
          style={{ opacity: locked && dir !== 'down' ? 0.45 : 1 }}
        >
          نزول ▼
        </button>
        <button
          type="button"
          className="btn-dir btn-up"
          onClick={actions.pickUp}
          disabled={locked}
          style={{ opacity: locked && dir !== 'up' ? 0.45 : 1 }}
        >
          صعود ▲
        </button>
        <div className="body-hint">{hint}</div>
      </div>
    </section>
  );
}

const ROW_H = 58;

function Leaderboard({ others, balance }) {
  const entries = [...others.map((o) => ({ ...o, me: false })), { name: 'شما', s: balance, me: true }];
  const sorted = [...entries].sort((a, b) => b.s - a.s);
  return (
    <section className="lb">
      <div className="lb-title">
        <TrophyIcon stroke={GOLD} />
        <span>لیدربورد</span>
      </div>
      <div className="lb-list">
        <div style={{ height: entries.length * ROW_H }} />
        {entries.map((r) => {
          const rank = sorted.findIndex((a) => a.name === r.name);
          return (
            <div
              key={r.name}
              className={r.me ? 'lb-row lb-row-me' : 'lb-row'}
              style={{ transform: `translateY(${rank * ROW_H}px)` }}
            >
              <span className="lb-rank">{fa(rank + 1)}</span>
              <span className="lb-name" dir={r.me ? 'rtl' : 'ltr'}>{r.name}</span>
              <span className="lb-score">{fa(r.s)} امتیاز</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Nav({ screen, actions }) {
  const isHome = screen === 'home';
  const isLB = screen === 'lb';
  return (
    <nav className="nav">
      <button type="button" className="nav-btn" style={{ color: isHome ? '#fff' : DIM }} onClick={actions.goHome}>
        <HomeIcon stroke={isHome ? GREEN : DIM} />
        خانه
      </button>
      <button type="button" className="nav-btn" style={{ color: DIM }} onClick={actions.startGame}>
        <GamepadIcon stroke={DIM} />
        بازی
      </button>
      <button type="button" className="nav-btn" style={{ color: isLB ? '#fff' : DIM }} onClick={actions.goLeaderboard}>
        <TrophyIcon stroke={isLB ? GREEN : DIM} />
        لیدربورد
      </button>
    </nav>
  );
}

export default function App() {
  const { state, actions, trackRef } = useGame();
  const { screen } = state;

  return (
    <div className="app" dir="rtl">
      <div className="phone">
        <TopBar balance={state.balance} />
        {screen === 'home' && <Home onStart={actions.startGame} />}
        {screen === 'game' && <Console state={state} actions={actions} trackRef={trackRef} />}
        {screen === 'lb' && <Leaderboard others={state.others} balance={state.balance} />}
        {screen !== 'game' && <Nav screen={screen} actions={actions} />}
      </div>
    </div>
  );
}
