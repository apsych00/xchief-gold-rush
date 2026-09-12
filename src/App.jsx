import { useEffect, useMemo, useState } from 'react';
import { LANG_KEY, LangContext, makeT, money, num, readStoredLang, useLang } from './i18n.js';
import LeadCapture from './LeadCapture.jsx';
import Logo from './Logo.jsx';
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

function TrophyIcon({ stroke, size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.7V17c0 .6-.4 1-1 1.3L7 20h10l-2-1.7c-.6-.3-1-.7-1-1.3v-2.3M18 2H6v7a6 6 0 0 0 12 0V2z" />
    </svg>
  );
}

function HomeIcon({ stroke }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function GamepadIcon({ stroke }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 11h4M8 9v4M15 12h.01M18 10h.01M17.3 5H6.7a4 4 0 0 0-4 3.6L2 15.6A2.4 2.4 0 0 0 6.2 17.5l1.6-2h8.4l1.6 2a2.4 2.4 0 0 0 4.2-1.9l-.7-7A4 4 0 0 0 17.3 5z" />
    </svg>
  );
}

function TopBar({ balance }) {
  const { t, lang, setLang } = useLang();
  return (
    <header className="topbar">
      <div className="topbar-start">
        <div className="logo" dir="ltr">
          <Logo height={30} />
        </div>
        <button
          type="button"
          className="lang-btn"
          onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}
          aria-label={lang === 'fa' ? 'Switch to English' : 'تغییر به فارسی'}
          lang={lang === 'fa' ? 'en' : 'fa'}
        >
          {t('langToggle')}
        </button>
      </div>
      <div className="balance-chip" aria-live="polite">
        <span className="coin-dot" aria-hidden="true" />
        <span className="balance-text">
          {num(balance, lang)} {t('pts')}
        </span>
      </div>
    </header>
  );
}

function Home({ balance, onStart }) {
  const { t, lang } = useLang();
  return (
    <section className="home">
      <div className="home-question">{t('home.question')}</div>
      <div className="hero" aria-hidden="true">
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
          {t('home.start')}
        </button>
        <div className="home-note">{t('home.note', { base: num(BASE_POINTS, lang) })}</div>
      </div>
      <LeadCapture source="home" balance={balance} />
    </section>
  );
}

function Chart({ history, start, color }) {
  const h = history.length ? history : [start ?? 0];
  const mn = Math.min(...h, start) - 0.05;
  const mx = Math.max(...h, start) + 0.05;
  const pts = h
    .map((v, i) => `${(i / Math.max(1, h.length - 1)) * 300},${80 - ((v - mn) / (mx - mn)) * 80}`)
    .join(' ');
  return (
    <svg viewBox="0 0 300 80" className="chart" aria-hidden="true">
      <line x1="0" y1="40" x2="300" y2="40" stroke="rgba(255,255,255,.25)" strokeDasharray="4 6" strokeWidth="1.5" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function FeedBadge({ feed }) {
  const { t } = useLang();
  const mode = feed.quiet ? 'quiet' : feed.mode;
  const label = t(`feed.${mode}`);
  const showSrc = feed.source && mode !== 'demo';
  return (
    <span className={`feed-badge feed-${mode}`} title={feed.source || undefined} dir="ltr">
      <span className="feed-dot" aria-hidden="true" />
      {label}
      {showSrc ? <span className="feed-src"> · {feed.source}</span> : null}
    </span>
  );
}

function Display({ state, actions }) {
  const { t, lang } = useLang();
  const { phase, price, start, end, lev, dir, remaining, history, win, tie, points, feed } = state;
  const isIdle = phase === 'idle';
  const isRunning = phase === 'running';
  const isResult = phase === 'result';
  const hasPrice = price != null;
  const delta = hasPrice && start != null ? price - start : 0;
  const up = delta >= 0;
  const deltaColor = up ? GREEN : RED;
  const digit = isRunning ? Math.max(1, Math.ceil(remaining)) : 0;

  return (
    <div className="display">
      <div className="display-inner">
        <div className="display-rays" aria-hidden="true" />
        <div className="display-vignette" aria-hidden="true" />
        <button type="button" className="btn-home" onClick={actions.goHome}>
          {t('game.home')}
        </button>
        <div className="feed-corner">
          <FeedBadge feed={feed} />
        </div>

        {isIdle && (
          <div className="pane pane-idle">
            <div className="ticker" dir="ltr">GOLD · XAUUSD</div>
            <div className={hasPrice ? 'price-big' : 'price-big price-waiting'} dir="ltr" aria-live="polite">
              {hasPrice ? money(price) : '— — —'}
            </div>
            <div className="feed-note">
              {!hasPrice
                ? t('feed.waiting')
                : feed.quiet
                  ? t('feed.noteQuiet')
                  : t('feed.note', { symbol: feed.symbol || 'PAXG/USD' })}
            </div>
            <div style={{ height: 10 }} />
            <div className="idle-title">{t('game.after')}</div>
            <div className="idle-help">{t('game.help')}</div>
            <div className="lev-pill">
              {t('game.levPill')} <span dir="ltr" className="lev-pill-x">×{lev}</span> · {t('game.win')}{' '}
              <span>{num(BASE_POINTS * lev, lang)}</span> {t('pts')}
            </div>
          </div>
        )}

        {isRunning && (
          <div className="pane pane-running">
            <div className="ticker ticker-sm" dir="ltr">GOLD · XAUUSD</div>
            <div className="price-row" dir="ltr">
              <span className="price-mid">{money(price ?? start)}</span>
              <span className="price-delta" style={{ color: deltaColor }}>
                {(up ? '▲ +' : '▼ ') + delta.toFixed(2)}
              </span>
            </div>
            <Chart history={history} start={start} color={deltaColor} />
            <div key={digit} className="countdown" dir="ltr" aria-live="polite">{digit}</div>
            <div className="locked-note">
              {t('game.locked')} · {dir === 'up' ? t('game.up') : t('game.down')} · {t('game.lever')}{' '}
              <span dir="ltr">×{lev}</span>
            </div>
          </div>
        )}

        {isResult && (
          <div className="pane pane-result">
            {win ? (
              <>
                <div className="coin-grid" aria-hidden="true">
                  {COIN_PX.map((c, i) => (
                    <div key={i} style={{ background: c }} />
                  ))}
                </div>
                <div className="win-row" dir="ltr">
                  <span className="win-word">WIN</span>
                  <span className="win-mult">×{lev}</span>
                </div>
                <div className="result-line">{t('result.winTitle')}</div>
                <div className="result-points">{t('result.winPoints', { pts: num(points, lang) })}</div>
                <div className="result-sub">
                  {t('result.winSub', { base: num(BASE_POINTS, lang), lev: num(lev, lang) })}
                </div>
              </>
            ) : tie ? (
              <>
                <div className="miss-word tie-word" dir="ltr">FLAT</div>
                <div className="result-line miss-line">{t('result.tieTitle')}</div>
                <div className="result-sub miss-sub">{t('result.tieSub')}</div>
              </>
            ) : (
              <>
                <div className="miss-word" dir="ltr">MISS</div>
                <div className="result-line miss-line">{t('result.missTitle')}</div>
                <div className="result-sub miss-sub">{t('result.missSub')}</div>
              </>
            )}
            <div className="result-stats">
              <div className="stat">
                <span className="stat-label">{t('result.start')}</span>
                <span className="stat-val" dir="ltr">{money(start ?? price)}</span>
              </div>
              <div className="stat">
                <span className="stat-label">{t('result.end')}</span>
                <span className="stat-val stat-val-gold" dir="ltr">{money(end ?? price)}</span>
              </div>
            </div>
            <div className="result-actions">
              <button type="button" className="btn-again" onClick={actions.playAgain}>
                {t('result.again')}
              </button>
              <button type="button" className="btn-lb" onClick={actions.goLeaderboard}>
                {t('result.lb')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Console({ state, actions, trackRef }) {
  const { t, lang } = useLang();
  const { phase, lev, dir, win, balance, price } = state;
  const isIdle = phase === 'idle';
  const isRunning = phase === 'running';
  const isResult = phase === 'result';
  const locked = !isIdle;
  const noPrice = price == null;
  const onGold = !isResult;

  const bodyClass = isResult ? (win ? 'body body-win' : 'body body-lose') : 'body body-gold';
  const levLabelColor = onGold ? (lev === 5 ? '#fff' : 'rgba(0,0,0,.7)') : '#fff';
  const tickColor = (m) => (lev === m ? '#fff' : onGold ? 'rgba(0,0,0,.5)' : 'rgba(255,255,255,.4)');

  let hint;
  if (isIdle && noPrice) hint = t('feed.waiting');
  else if (isIdle) hint = t('body.hintIdle');
  else if (isRunning) hint = t('body.hintRunning');
  else if (win) hint = t('body.hintWin', { bal: num(balance, lang) });
  else hint = t('body.hintLose');

  const onKey = (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') actions.setLev(lev === 1 ? 2 : 5);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') actions.setLev(lev === 5 ? 2 : 1);
    else return;
    e.preventDefault();
  };

  return (
    <section className="console">
      <Display state={state} actions={actions} />

      <div className={bodyClass}>
        <div className="body-sheen" aria-hidden="true" />
        <div className="lev-label" style={{ color: levLabelColor }}>
          <span>{t('body.lever')}</span>
          <span className="lev-label-x" dir="ltr">×{lev}</span>
          <span className="lev-lock" style={{ opacity: locked ? 1 : 0 }} aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z" />
            </svg>
          </span>
        </div>

        <div
          ref={trackRef}
          className={locked ? 'slider slider-locked' : 'slider'}
          role="slider"
          aria-label={t('body.lever')}
          aria-valuemin={1}
          aria-valuemax={5}
          aria-valuenow={lev}
          aria-valuetext={`×${lev}`}
          aria-disabled={locked}
          tabIndex={0}
          onPointerDown={actions.sliderDown}
          onPointerMove={actions.sliderMove}
          onPointerUp={actions.sliderUp}
          onPointerCancel={actions.sliderUp}
          onKeyDown={onKey}
        >
          <div className="slider-track" />
          <div className="slider-knob" style={{ top: KNOB_TOP[lev] }} dir="ltr">
            ×{lev}
          </div>
        </div>
        {[5, 2, 1].map((m) => (
          <button
            key={m}
            type="button"
            className={`tick tick-${m}`}
            dir="ltr"
            style={{ color: tickColor(m) }}
            onClick={() => actions.setLev(m)}
            disabled={locked}
            aria-label={`×${m}`}
            aria-pressed={lev === m}
          >
            ×{m}
          </button>
        ))}

        <button
          type="button"
          className="btn-dir btn-down"
          onClick={actions.pickDown}
          disabled={locked || noPrice}
          style={{ opacity: (locked && dir !== 'down') || noPrice ? 0.45 : 1 }}
        >
          {t('game.down')}
        </button>
        <button
          type="button"
          className="btn-dir btn-up"
          onClick={actions.pickUp}
          disabled={locked || noPrice}
          style={{ opacity: (locked && dir !== 'up') || noPrice ? 0.45 : 1 }}
        >
          {t('game.up')}
        </button>
        <div className="body-hint" aria-live="polite">{hint}</div>
      </div>
    </section>
  );
}

const ROW_H = 58;

function Leaderboard({ others, balance }) {
  const { t, lang } = useLang();
  const you = t('lb.you');
  const entries = [...others.map((o) => ({ ...o, me: false })), { name: you, s: balance, me: true }];
  const sorted = [...entries].sort((a, b) => b.s - a.s);
  return (
    <section className="lb">
      <div className="lb-title">
        <TrophyIcon stroke={GOLD} />
        <span>{t('lb.title')}</span>
      </div>
      <div className="lb-list">
        <div style={{ height: entries.length * ROW_H }} />
        {entries.map((r) => {
          const rank = sorted.findIndex((a) => a.name === r.name);
          return (
            <div
              key={r.me ? '__me' : r.name}
              className={r.me ? 'lb-row lb-row-me' : 'lb-row'}
              style={{ transform: `translateY(${rank * ROW_H}px)` }}
            >
              <span className="lb-rank">{num(rank + 1, lang)}</span>
              <span className="lb-name" dir={r.me ? undefined : 'ltr'}>{r.name}</span>
              <span className="lb-score">
                {num(r.s, lang)} {t('pts')}
              </span>
            </div>
          );
        })}
      </div>
      <LeadCapture source="leaderboard" balance={balance} variant="slim" title={t('lead.lbTitle')} subtitle={t('lead.lbSub')} />
    </section>
  );
}

function Nav({ screen, actions }) {
  const { t } = useLang();
  const isHome = screen === 'home';
  const isLB = screen === 'lb';
  return (
    <nav className="nav">
      <button type="button" className="nav-btn" aria-current={isHome ? 'page' : undefined} style={{ color: isHome ? '#fff' : DIM }} onClick={actions.goHome}>
        <HomeIcon stroke={isHome ? GREEN : DIM} />
        {t('nav.home')}
      </button>
      <button type="button" className="nav-btn nav-btn-play" style={{ color: DIM }} onClick={actions.startGame}>
        <GamepadIcon stroke={DIM} />
        {t('nav.play')}
      </button>
      <button type="button" className="nav-btn" aria-current={isLB ? 'page' : undefined} style={{ color: isLB ? '#fff' : DIM }} onClick={actions.goLeaderboard}>
        <TrophyIcon stroke={isLB ? GREEN : DIM} size={22} />
        {t('nav.lb')}
      </button>
    </nav>
  );
}

export default function App() {
  const { state, actions, trackRef } = useGame();
  const { screen } = state;
  const [lang, setLangState] = useState(readStoredLang);

  const langCtx = useMemo(() => {
    const setLang = (next) => {
      setLangState(next);
      try {
        localStorage.setItem(LANG_KEY, next);
      } catch {
        /* storage unavailable */
      }
    };
    return { lang, t: makeT(lang), setLang };
  }, [lang]);

  const dir = lang === 'fa' ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  return (
    <LangContext.Provider value={langCtx}>
      <div className="app" dir={dir} data-lang={lang}>
        <div className="phone">
          <TopBar balance={state.balance} />
          {screen === 'home' && <Home balance={state.balance} onStart={actions.startGame} />}
          {screen === 'game' && <Console state={state} actions={actions} trackRef={trackRef} />}
          {screen === 'lb' && <Leaderboard others={state.others} balance={state.balance} />}
          {screen !== 'game' && <Nav screen={screen} actions={actions} />}
        </div>
      </div>
    </LangContext.Provider>
  );
}
