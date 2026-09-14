import { useEffect, useMemo, useRef, useState } from 'react';
import { COMBO_MAX, comboMult, ECON, levelFor, nextLevel, SIGNUP_PROMPT_LEVEL, TASKS } from './config.js';
import { ENABLED_LANGS, LANG_KEY, LangContext, makeT, money, num, readStoredLang, useLang } from './i18n.js';
import UpdateBanner from './UpdateBanner.jsx';
import LeadCapture from './LeadCapture.jsx';
import { readLead, readSignup } from './leads.js';
import SignupForm from './SignupForm.jsx';
import Logo from './Logo.jsx';
import Tasks from './Tasks.jsx';

const SIGNUP_REWARD = TASKS.find((t) => t.id === 'signup')?.reward ?? 1000;
import { LEVERS, maxAffordableLever, stakeFor, useGame } from './useGame.js';

const GREEN = '#35E36F';
const GOLD = '#E9B62A';
const RED = '#FF5C5C';
const DIM = 'rgba(255,255,255,.55)';

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

/* ---------- icons ---------- */

function TrophyIcon({ stroke, size = 22 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.7V17c0 .6-.4 1-1 1.3L7 20h10l-2-1.7c-.6-.3-1-.7-1-1.3v-2.3M18 2H6v7a6 6 0 0 0 12 0V2z" />
    </svg>
  );
}
function HomeIcon({ stroke }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
function GamepadIcon({ stroke }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 11h4M8 9v4M15 12h.01M18 10h.01M17.3 5H6.7a4 4 0 0 0-4 3.6L2 15.6A2.4 2.4 0 0 0 6.2 17.5l1.6-2h8.4l1.6 2a2.4 2.4 0 0 0 4.2-1.9l-.7-7A4 4 0 0 0 17.3 5z" />
    </svg>
  );
}
function GiftIcon({ stroke }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
    </svg>
  );
}
function CoinDot() {
  return <span className="coin-dot" aria-hidden="true" />;
}

/* ---------- chrome ---------- */

function TopBar({ profile }) {
  const { t, lang, setLang } = useLang();
  return (
    <header className="topbar">
      <div className="topbar-start">
        <div className="logo" dir="ltr">
          <Logo height={26} />
        </div>
        {ENABLED_LANGS.length > 1 && (
          <button
            type="button"
            className="lang-btn"
            onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}
            aria-label={lang === 'fa' ? 'Switch to English' : 'تغییر به فارسی'}
            lang={lang === 'fa' ? 'en' : 'fa'}
          >
            {t('langToggle')}
          </button>
        )}
      </div>
      <div className="balance-chip" aria-live="polite">
        <CoinDot />
        <span className="balance-text">{num(profile.coins, lang)}</span>
      </div>
    </header>
  );
}

function Toast({ toast }) {
  const { t, lang } = useLang();
  if (!toast) return null;
  let text = toast.text;
  if (text === 'limit') text = t('toast.limit');
  else if (/^\+\d+$/.test(text)) text = t('toast.coins', { n: num(Number(text.slice(1)), lang) });
  return (
    <div className="toast" role="status">
      {text}
    </div>
  );
}

/* ---------- home ---------- */

function Home({ profile, actions }) {
  const { t, lang } = useLang();
  const level = levelFor(profile.record);
  const next = nextLevel(profile.record);
  return (
    <section className="home">
      <div className="home-question">{t('home.question')}</div>
      <div className="hero" aria-hidden="true">
        <div className="hero-ring" />
        <div className="hero-glow" />
        <img
          className="hero-art"
          src="/hero-gold.webp"
          srcSet="/hero-gold.webp 640w, /hero-gold@2x.webp 1024w"
          sizes="(max-width: 430px) 60vw, 260px"
          alt=""
          draggable={false}
        />
      </div>
      <div className="stats">
        <div className="stat-card">
          <div className="stat-k">{t('record')}</div>
          <div className="stat-v">
            <TrophyIcon stroke={GOLD} size={16} />
            {num(profile.record, lang)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-k">{t(`level.${level.id}`)}</div>
          <div className="stat-v stat-v-small">
            {next
              ? t('home.toNext', { n: num(next.min - profile.record, lang), level: t(`level.${next.id}`) })
              : t('home.maxLevel')}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-k">{t('streak')}</div>
          <div className="stat-v stat-v-combo" dir="ltr">
            {profile.streak > 0 ? '🔥 ' : ''}×{num(comboMult(profile.streak), lang)}
          </div>
        </div>
      </div>
      <div className="home-cta">
        <button type="button" className="btn-start" onClick={actions.startGame}>
          {t('home.start')}
        </button>
        <div className="home-rules">{t('home.rules', { max: num(COMBO_MAX, lang) })}</div>
        <div className="home-note">
          {t('home.note', { base: num(ECON.stakeBase, lang) })}
          {' · '}
          <button type="button" className="link-btn" onClick={actions.goTasks}>
            {t('home.more')}
          </button>
        </div>
      </div>
    </section>
  );
}

/* ---------- game ---------- */

function Chart({ history, start, color }) {
  const h = history.length ? history : [start ?? 0];
  const mn = Math.min(...h, start ?? h[0]) - 0.05;
  const mx = Math.max(...h, start ?? h[0]) + 0.05;
  const pts = h.map((v, i) => `${(i / Math.max(1, h.length - 1)) * 300},${80 - ((v - mn) / (mx - mn)) * 80}`).join(' ');
  return (
    <svg viewBox="0 0 300 80" className="chart" aria-hidden="true" preserveAspectRatio="none">
      <line x1="0" y1="40" x2="300" y2="40" stroke="rgba(255,255,255,.25)" strokeDasharray="4 6" strokeWidth="1.5" />
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Combo meter: one pip per multiplier step, lit up to the current streak. */
function ComboBar({ streak, compact = false }) {
  const { t, lang } = useLang();
  const mult = comboMult(streak);
  const steps = ECON.combo.length; // pips = number of multiplier levels
  const lit = Math.min(streak, steps - 1);
  const atMax = streak >= steps - 1;
  return (
    <div
      className={`combo ${compact ? 'combo-compact' : ''} ${streak > 0 ? 'combo-on' : ''} ${atMax ? 'combo-max' : ''}`}
      dir="ltr"
      aria-label={`${t('combo.label')} ×${mult}`}
    >
      <span className="combo-label">{t('combo.label')}</span>
      <span className="combo-pips" aria-hidden="true">
        {ECON.combo.slice(1).map((m, i) => (
          <span key={m} className={`combo-pip ${i < lit ? 'combo-pip-on' : ''}`}>
            ×{num(m, lang)}
          </span>
        ))}
      </span>
      <span className="combo-mult">×{num(mult, lang)}</span>
    </div>
  );
}

function FeedBadge({ feed }) {
  const { t } = useLang();
  const mode = feed.quiet ? 'quiet' : feed.mode;
  return (
    <span className={`feed-badge feed-${mode}`} title={feed.source || undefined} dir="ltr">
      <span className="feed-dot" aria-hidden="true" />
      {t(`feed.${mode}`)}
      {feed.source && mode !== 'demo' ? <span className="feed-src"> · {feed.source}</span> : null}
    </span>
  );
}

function Display({ state, profile, actions }) {
  const { t, lang } = useLang();
  const { phase, price, start, end, lev, dir, remaining, history, result, feed } = state;
  const isIdle = phase === 'idle';
  const isRunning = phase === 'running';
  const isResult = phase === 'result';
  const hasPrice = price != null;
  const delta = hasPrice && start != null ? price - start : 0;
  const up = delta >= 0;
  const deltaColor = up ? GREEN : RED;
  const digit = isRunning ? Math.max(1, Math.ceil(remaining)) : 0;
  const stake = stakeFor(lev);
  const isNewRecord =
    isResult && result?.outcome === 'win' && profile.coins === profile.record && profile.record > ECON.startCoins;
  const curMult = comboMult(profile.streak); // multiplier the NEXT win will pay
  const potential = Math.round(stake * curMult);
  // Ask for the email once, right after the first win: the player now has a
  // score worth saving. Never shown again after it has been answered/skipped.
  const emailPrompt = isResult && !readLead() && !profile.prompts.email_win && profile.wins >= 1;
  // Once shown it counts as asked, even if the player just moves on.
  const markPromptRef = useRef(actions.markPrompt);
  markPromptRef.current = actions.markPrompt;
  useEffect(() => {
    if (!emailPrompt) return undefined;
    return () => markPromptRef.current('email_win');
  }, [emailPrompt]);

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
            <div className="ticker" dir="ltr">
              GOLD · XAUUSD
            </div>
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
            <div className="idle-title">{t('game.after')}</div>
            <div className="idle-help">{t('game.help')}</div>
            <div className="lev-pill">
              {t('game.stake')} <b>{num(stake, lang)}</b> {t('coins')} · {t('game.win')}{' '}
              <b className="txt-green">+{num(potential, lang)}</b>
            </div>
            <ComboBar streak={profile.streak} />
          </div>
        )}

        {isRunning && (
          <div className="pane pane-running">
            <div className="ticker ticker-sm" dir="ltr">
              GOLD · XAUUSD
            </div>
            <div className="price-row" dir="ltr">
              <span className="price-mid">{money(price ?? start)}</span>
              <span className="price-delta" style={{ color: deltaColor }}>
                {(up ? '▲ +' : '▼ ') + delta.toFixed(2)}
              </span>
            </div>
            <Chart history={history} start={start} color={deltaColor} />
            <div key={digit} className="countdown" dir="ltr" aria-live="polite">
              {digit}
            </div>
            <div className="locked-note">
              {t('game.locked')} · {dir === 'up' ? t('game.up') : t('game.down')} · {t('game.stake')} {num(stake, lang)}
              {curMult > 1 ? ` · ×${num(curMult, lang)}` : ''}
            </div>
          </div>
        )}

        {isResult && result && (
          <div className={`pane pane-result ${emailPrompt ? 'pane-result-lead' : ''}`}>
            {result.outcome === 'win' && (
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
                <div className="result-line">{isNewRecord ? t('result.newRecord') : t('result.winTitle')}</div>
                <div className="result-points">{t('result.winDelta', { n: num(result.delta, lang) })}</div>
                <div className="result-sub">
                  {result.mult > 1
                    ? t('result.streakTag', {
                        n: num(result.streak, lang),
                        stake: num(result.stake, lang),
                        mult: num(result.mult, lang),
                      })
                    : t('result.winSub', { stake: num(result.stake, lang), mult: num(1, lang) })}
                  {result.badge ? ` · ${t(`result.badge.${result.badge}`)}` : ''}
                </div>
                <div className="result-next">
                  {profile.streak >= ECON.combo.length - 1
                    ? t('result.maxCombo', { mult: num(COMBO_MAX, lang) })
                    : t('result.nextCombo', { mult: num(comboMult(profile.streak), lang) })}
                </div>
              </>
            )}
            {result.outcome === 'flat' && (
              <>
                <div className="miss-word tie-word" dir="ltr">
                  FLAT
                </div>
                <div className="result-line miss-line">{t('result.tieTitle')}</div>
                <div className="result-sub miss-sub">{t('result.tieSub')}</div>
              </>
            )}
            {result.outcome === 'lose' && (
              <>
                <div className="miss-word" dir="ltr">
                  MISS
                </div>
                <div className="result-line miss-line">{t('result.missTitle')}</div>
                <div className="result-points result-points-neg">
                  {t('result.missDelta', { n: num(result.stake, lang) })}
                </div>
                <div className="result-sub miss-sub">{t('result.missSub')}</div>
              </>
            )}
            {result.outcome === 'win' && emailPrompt && (
              <LeadCapture
                source="first-win"
                balance={profile.coins}
                variant="result"
                title={t('lead.winTitle')}
                subtitle={t('lead.winSub')}
                onDone={() => actions.markPrompt('email_win')}
                onDismiss={() => actions.markPrompt('email_win')}
              />
            )}
            <div className="result-stats">
              <div className="stat">
                <span className="stat-label">{t('result.start')}</span>
                <span className="stat-val" dir="ltr">
                  {money(start ?? price)}
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">{t('result.end')}</span>
                <span className="stat-val stat-val-gold" dir="ltr">
                  {money(end ?? price)}
                </span>
              </div>
            </div>
            <div className="result-actions">
              {profile.coins >= ECON.brokeBelow || !profile.freeRefillUsed ? (
                <button type="button" className="btn-again" onClick={actions.playAgain}>
                  {t('result.again')}
                </button>
              ) : (
                <button type="button" className="btn-again" onClick={actions.goTasks}>
                  {t('result.tasks')}
                </button>
              )}
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

function Console({ state, profile, actions, trackRef }) {
  const { t, lang } = useLang();
  const { phase, lev, dir, result, price } = state;
  const isIdle = phase === 'idle';
  const isRunning = phase === 'running';
  const isResult = phase === 'result';
  const locked = !isIdle;
  const noPrice = price == null;
  const win = isResult && result?.outcome === 'win';
  const broke = isIdle && maxAffordableLever(profile.coins) === null;
  const onGold = !isResult;
  const signupDone = !!readSignup();
  const [signupFor, setSignupFor] = useState(null); // 'signup_broke' | 'signup_trader' | null

  // Offer the signup once when the player first reaches the Trader level:
  // a proud moment for a good player who never goes broke.
  const emailAsked = !!readLead() || !!profile.prompts.email_win;
  const traderPrompt =
    isResult &&
    result?.outcome === 'win' &&
    emailAsked && // never stack on the first-win email prompt
    !signupDone &&
    !profile.prompts.signup_trader &&
    levelFor(profile.record).id === SIGNUP_PROMPT_LEVEL;
  useEffect(() => {
    if (traderPrompt && !signupFor) setSignupFor('signup_trader');
  }, [traderPrompt, signupFor]);

  const closeSignup = () => {
    if (signupFor) actions.markPrompt(signupFor);
    setSignupFor(null);
  };

  const bodyClass = isResult ? (win ? 'body body-win' : 'body body-lose') : 'body body-gold';
  const levLabelColor = onGold ? (lev === 5 ? '#fff' : 'rgba(0,0,0,.7)') : '#fff';
  const canAfford = (m) => stakeFor(m) <= profile.coins;
  const tickColor = (m) =>
    !canAfford(m)
      ? onGold
        ? 'rgba(0,0,0,.25)'
        : 'rgba(255,255,255,.2)'
      : lev === m
        ? '#fff'
        : onGold
          ? 'rgba(0,0,0,.5)'
          : 'rgba(255,255,255,.4)';

  let hint;
  if (broke) hint = t('body.cantAfford');
  else if (isIdle && noPrice) hint = t('feed.waiting');
  else if (isIdle) hint = t('body.hintIdle');
  else if (isRunning) hint = t('body.hintRunning');
  else if (win) hint = t('body.hintWin', { bal: num(profile.coins, lang) });
  else hint = t('body.hintLose');

  const onKey = (e) => {
    const i = LEVERS.indexOf(lev);
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') actions.setLev(LEVERS[Math.min(LEVERS.length - 1, i + 1)]);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') actions.setLev(LEVERS[Math.max(0, i - 1)]);
    else return;
    e.preventDefault();
  };

  return (
    <section className="console">
      <Display state={state} profile={profile} actions={actions} />
      <div className={bodyClass}>
        <div className="body-scale">
          <div className="body-sheen" aria-hidden="true" />
          <div className="lev-label" style={{ color: levLabelColor }}>
            <span>{t('body.lever')}</span>
            <span className="lev-label-x" dir="ltr">
              ×{lev}
            </span>
            <span className="lev-stake" dir="ltr">
              = {num(stakeFor(lev), lang)}
            </span>
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
              disabled={locked || !canAfford(m)}
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
            disabled={locked || noPrice || broke}
            style={{ opacity: (locked && dir !== 'down') || noPrice || broke ? 0.45 : 1 }}
          >
            {t('game.down')}
          </button>
          <button
            type="button"
            className="btn-dir btn-up"
            onClick={actions.pickUp}
            disabled={locked || noPrice || broke}
            style={{ opacity: (locked && dir !== 'up') || noPrice || broke ? 0.45 : 1 }}
          >
            {t('game.up')}
          </button>
          <div className="body-hint" aria-live="polite">
            {hint}
          </div>

          {broke && !signupDone && (
            <div className="broke">
              <div className="broke-title">{t('signup.brokeTitle')}</div>
              <div className="broke-sub">{t('signup.brokeSub', { n: num(SIGNUP_REWARD, lang) })}</div>
              <button type="button" className="btn-primary" onClick={() => setSignupFor('signup_broke')}>
                {t('signup.cta', { n: num(SIGNUP_REWARD, lang) })}
              </button>
              {!profile.freeRefillUsed ? (
                <button type="button" className="link-btn broke-alt" onClick={actions.freeRefill}>
                  {t('signup.brokeAlt', { n: num(ECON.freeRefill, lang) })}
                </button>
              ) : (
                <button type="button" className="link-btn broke-alt" onClick={actions.goTasks}>
                  {t('signup.brokeAltUsed')}
                </button>
              )}
            </div>
          )}
          {broke && signupDone && !profile.freeRefillUsed && (
            <div className="broke">
              <div className="broke-title">{t('game.freeTitle')}</div>
              <div className="broke-sub">{t('game.freeSub')}</div>
              <button type="button" className="btn-primary" onClick={actions.freeRefill}>
                {t('game.freeCta', { n: num(ECON.freeRefill, lang) })}
              </button>
            </div>
          )}
          {broke && signupDone && profile.freeRefillUsed && (
            <div className="broke">
              <div className="broke-title">{t('game.brokeTitle')}</div>
              <div className="broke-sub">{t('game.brokeSub')}</div>
              <button type="button" className="btn-primary" onClick={actions.goTasks}>
                {t('game.brokeCta')}
              </button>
            </div>
          )}
        </div>
      </div>
      {signupFor && (
        <SignupForm
          source={signupFor}
          balance={profile.coins}
          reward={num(SIGNUP_REWARD, lang)}
          onDone={() => {
            actions.markPrompt(signupFor);
            actions.claimTask('signup');
          }}
          onCancel={closeSignup}
        />
      )}
    </section>
  );
}

/* ---------- leaderboard ---------- */

function Leaderboard({ others, profile }) {
  const { t, lang } = useLang();
  const you = t('lb.you');
  const entries = [...others.map((o) => ({ ...o, me: false })), { name: you, s: profile.record, me: true }];
  const sorted = [...entries].sort((a, b) => b.s - a.s);
  const myRank = sorted.findIndex((a) => a.me);
  return (
    <section className="lb">
      <div className="screen-head">
        <div className="screen-title">
          <TrophyIcon stroke={GOLD} size={24} /> {t('lb.title')}
        </div>
        <div className="screen-sub">{t('lb.byRecord')}</div>
      </div>
      <div className="lb-list">
        <div className="lb-spacer" style={{ '--n': entries.length }} />
        {entries.map((r) => {
          const rank = sorted.findIndex((a) => a.name === r.name);
          const level = levelFor(r.s);
          return (
            <div key={r.me ? '__me' : r.name} className={r.me ? 'lb-row lb-row-me' : 'lb-row'} style={{ '--i': rank }}>
              <span className="lb-rank">{num(rank + 1, lang)}</span>
              <span className="lb-name" dir={r.me ? undefined : 'ltr'}>
                {r.name}
                <span className="lb-level">{t(`level.${level.id}`)}</span>
              </span>
              <span className="lb-score">{num(r.s, lang)}</span>
            </div>
          );
        })}
      </div>
      {myRank < 10 && !readLead() && (
        <LeadCapture
          source="leaderboard"
          balance={profile.coins}
          variant="slim"
          title={t('lead.lbTitle')}
          subtitle={t('lead.lbSub')}
        />
      )}
    </section>
  );
}

/* ---------- nav ---------- */

function Nav({ screen, actions }) {
  const { t } = useLang();
  const items = [
    { id: 'home', label: t('nav.home'), Icon: HomeIcon, go: actions.goHome },
    { id: 'game', label: t('nav.play'), Icon: GamepadIcon, go: actions.startGame },
    { id: 'tasks', label: t('nav.tasks'), Icon: GiftIcon, go: actions.goTasks },
    { id: 'lb', label: t('nav.lb'), Icon: TrophyIcon, go: actions.goLeaderboard },
  ];
  return (
    <nav className="nav">
      {items.map(({ id, label, Icon, go }) => {
        const active = screen === id;
        return (
          <button
            key={id}
            type="button"
            className="nav-btn"
            aria-current={active ? 'page' : undefined}
            style={{ color: active ? '#fff' : DIM }}
            onClick={go}
          >
            <Icon stroke={active ? GREEN : DIM} />
            {label}
          </button>
        );
      })}
    </nav>
  );
}

/* ---------- app ---------- */

export default function App() {
  const { state, profile, actions, trackRef } = useGame();
  const { screen } = state;
  const [lang, setLangState] = useState(readStoredLang);

  const langCtx = useMemo(() => {
    const setLang = (next) => {
      setLangState(next);
      try {
        localStorage.setItem(LANG_KEY, next);
      } catch {
        /* ignore */
      }
    };
    return { lang, t: makeT(lang), setLang };
  }, [lang]);

  const dir = lang === 'fa' ? 'rtl' : 'ltr';
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  // Scale factor for the fixed-pixel console art: the design is 390×844, so
  // anything smaller (short Androids, landscape, small frames) shrinks it
  // proportionally instead of overflowing. Measured from the phone frame so
  // the desktop "phone" view scales too.
  const phoneRef = useRef(null);
  useEffect(() => {
    const el = phoneRef.current;
    if (!el) return undefined;
    const apply = () => {
      const s = Math.min(el.clientHeight / 844, el.clientWidth / 390, 1);
      document.documentElement.style.setProperty('--s', String(Math.max(0.55, s).toFixed(4)));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener('orientationchange', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('orientationchange', apply);
    };
  }, []);

  return (
    <LangContext.Provider value={langCtx}>
      <div className="app" dir={dir} data-lang={lang}>
        <div className="phone" ref={phoneRef}>
          <TopBar profile={profile} />
          {screen === 'home' && <Home profile={profile} actions={actions} />}
          {screen === 'game' && <Console state={state} profile={profile} actions={actions} trackRef={trackRef} />}
          {screen === 'lb' && <Leaderboard others={state.others} profile={profile} />}
          {screen === 'tasks' && (
            <Tasks profile={profile} onClaim={actions.claimTask} onToast={(txt) => actions.toast?.(txt)} />
          )}
          {screen !== 'game' && <Nav screen={screen} actions={actions} />}
          <Toast toast={state.toast} />
          <UpdateBanner />
        </div>
      </div>
    </LangContext.Provider>
  );
}
