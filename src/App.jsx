import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { COMBO_MAX, comboMult, ECON, levelFor, nextLevel, SIGNUP_PROMPT_LEVEL } from './config.js';
import { LANG_KEY, LangContext, makeT, money, num, readStoredLang, useLang } from './i18n.js';
import UpdateBanner from './UpdateBanner.jsx';
import LeadCapture from './LeadCapture.jsx';
import { mayAskEmail, readLead, readSignup } from './leads.js';
import SignupForm from './SignupForm.jsx';
import Logo from './Logo.jsx';
import Tasks from './Tasks.jsx';
import { IS_KIOSK } from './api/kiosk.js';
import KioskApp from './KioskApp.jsx';
import { enabled as apiEnabled } from './api/client.js';
import OtpModal from './Identity.jsx';
import Profile, { UserIcon } from './Profile.jsx';

import { AdZone, warmBanners } from './ads.js';
import { LEVERS, maxAffordableLever, stakeFor, useGame } from './useGame.js';
import Splash from './Splash.jsx';
import { useBootReady } from './useBootReady.js';

// Offline-only fallback (docs/layers.md C5): the no-backend preview mode (VITE_GAME_WS unset -
// see src/api/client.js) never gets a `tasks` frame to read a reward number from. Whenever a
// real server is connected, the signup reward shown here always comes from state.tasksRows
// instead - never this constant.
const FALLBACK_SIGNUP_REWARD = 1000;

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

export function TopBar({ profile, actions, active, identityKnown, onSignIn, onNavigate }) {
  const { t, lang } = useLang();
  const level = levelFor(profile.record);
  // A guest has no profile worth opening from here, so the slot offers the thing they need
  // instead. Gated on mayAskEmail rather than on the flag alone: until the server has said who
  // this player is, a verified player is indistinguishable from a new one, and flashing "Sign in"
  // at someone already signed in is exactly the mistake that rule exists to prevent.
  const showSignIn = !!onSignIn && mayAskEmail(identityKnown, profile);
  // The kiosk reuses this component with no `onNavigate` at all - `navigate(undefined)` is then a
  // no-op, same as the plain `actions?.goHome` this replaced. Where `onNavigate` is supplied
  // (web), leaving the play screen mid-round is guarded exactly like a Nav tap (ticket:
  // nav-on-play's useGame.js requestNav).
  const navigate = (fn) => () => {
    if (!fn) return;
    if (onNavigate) onNavigate(fn);
    else fn();
  };
  return (
    <header className="topbar">
      <div className="topbar-start">
        <button
          type="button"
          className="logo logo-home"
          onClick={navigate(actions?.goHome)}
          aria-label="xChief home"
          dir="ltr"
        >
          <Logo height={26} />
        </button>
      </div>
      <div className="topbar-end">
        <div className="balance-chip" aria-live="polite">
          <CoinDot />
          <span className="balance-text">{num(profile.coins, lang)}</span>
        </div>
        {/* The kiosk passes no actions: no profile, no avatar (docs/layers.md C2). */}
        {showSignIn && (
          <button type="button" className="signin-chip" onClick={onSignIn}>
            {t('identity.signIn')}
          </button>
        )}
        {!showSignIn && actions?.goProfile && (
          <button
            type="button"
            className={`avatar-btn ${active ? 'avatar-btn-on' : ''} avatar-${level.id}`}
            onClick={navigate(actions.goProfile)}
            aria-label={t('profile.open')}
            aria-current={active ? 'page' : undefined}
          >
            <UserIcon size={24} />
            {profile.streak > 0 && (
              <span className="avatar-flame" aria-hidden="true">
                🔥
              </span>
            )}
          </button>
        )}
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

// Ticket C11: the real first-visit tour (A5) on the B10 mount point, reusing the existing
// .modal-backdrop/.modal vocabulary. Three cards, one at a time, with dots; Next advances and
// the last card's button is "Got it" (tests/e2e/first-visit.js clicks it). Cards 1-2 also offer
// Skip, and either path ends the tour through onDone - markTourSeen() in src/useGame.js, which
// owns the xchief.tour_seen flag that shows the tour once per device.
const TOUR_CARDS = ['card1', 'card2', 'card3'];

// Card 3 is the tour's one email ask ("Verify your email to be ranked"), so it follows the same
// rule as every other ask (src/leads.js's mayAskEmail): it renders only while the app KNOWS the
// player has no verified email. A first visit starts unknown, so the tour opens on two cards and
// grows the verify card the moment the server's `me` row says this player is unverified; a
// verified player - or one still connecting - never sees it.
const TOUR_CARDS_NO_VERIFY = TOUR_CARDS.filter((c) => c !== 'card3');

function TourPlaceholder({ cards, onDone }) {
  const { t } = useLang();
  const [step, setStep] = useState(0);
  const last = step === cards.length - 1;
  const card = cards[step];
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t(`tour.${card}.title`)}>
      <div className="modal">
        <div className="modal-title">{t(`tour.${card}.title`)}</div>
        <div className="modal-sub">{t(`tour.${card}.body`)}</div>
        <div className="tour-dots" aria-hidden="true">
          {cards.map((c, i) => (
            <span key={c} className={i === step ? 'tour-dot tour-dot-on' : 'tour-dot'} />
          ))}
        </div>
        <div className="modal-actions tour-actions">
          {!last && (
            <button type="button" className="link-btn" onClick={onDone}>
              {t('tour.skip')}
            </button>
          )}
          <button
            type="button"
            className="btn-primary tour-primary"
            onClick={() => {
              if (last) onDone();
              else setStep(step + 1);
            }}
          >
            {last ? t('tour.gotIt') : t('tour.next')}
          </button>
        </div>
      </div>
    </div>
  );
}

// Ticket OD-modal: the global, blocking "socket is down" modal. Keyed on state.feed (see
// initialGame.feed in src/useGame.js and startPriceFeed in src/priceFeed.js) - mode ===
// 'connecting' means the socket is not currently connected and authed. Shown only after a
// grace period so it never flashes on a cold start while the first socket opens normally, and
// it clears itself the instant the socket connects. Reuses the .modal-backdrop/.modal
// vocabulary (see TourPlaceholder above); no close button, no Esc, no backdrop click - the
// point is that nothing underneath is usable until the socket is back.
const CONNECTION_MODAL_DELAY_MS = 4000;

function ConnectionModal({ feed }) {
  const { t } = useLang();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (feed.mode !== 'connecting') {
      setVisible(false);
      return undefined;
    }
    const timer = setTimeout(() => setVisible(true), CONNECTION_MODAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [feed.mode]);

  if (!visible) return null;
  const title = feed.connectionRefused ? t('conn.refusedTitle') : t('conn.lostTitle');
  return (
    <div className="modal-backdrop" role="alertdialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <div className="modal-title">{title}</div>
        <div className="modal-sub">
          {t('conn.reconnecting')}
          <span className="conn-dots" aria-hidden="true">
            <span className="conn-dot" />
            <span className="conn-dot" />
            <span className="conn-dot" />
          </span>
        </div>
      </div>
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
  if (streak === 0) {
    return (
      <div className="combo combo-idle" dir="ltr" aria-label={`${t('combo.idle')} ×${mult}`}>
        <span>{t('combo.idle')} ·</span>
        <span className="combo-mult">×{num(mult, lang)}</span>
      </div>
    );
  }
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
  const { phase, price, start, end, lev, dir, remaining, history, result, feed, identityKnown } = state;
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
  // Kiosk visitors are anonymous by design (docs/layers.md): no email prompt ever.
  // mayAskEmail keeps this silent until the server has said this player is NOT verified - during
  // the connect window a verified user must never see the prompt, and the once-only
  // markPrompt('email_win') below must never be burned by a wrong-person flash of it.
  const emailPrompt =
    !IS_KIOSK &&
    isResult &&
    mayAskEmail(identityKnown, profile) &&
    !readLead() &&
    !profile.prompts.email_win &&
    profile.wins >= 1;
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
                {(up ? '▲ +' : '▼ ') + (Math.abs(delta) >= 0.01 ? delta.toFixed(2) : delta.toFixed(3))}
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
                  {/* result.delta is the frame's own number (server/rounds.js, round_settled): for a
                      loss it is already -stake, so the amount shown here is the server's figure,
                      not a client-recomputed stake (docs/layers.md C6 audit). */}
                  {t('result.missDelta', { n: num(Math.abs(result.delta), lang) })}
                </div>
                <div className="result-sub miss-sub">{t('result.missSub')}</div>
              </>
            )}
            {result.coupon && (
              <div dir="ltr" style={{ marginTop: 8, fontWeight: 700 }}>
                Code: {result.coupon}
              </div>
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
            {/* The result pane is the only screen a kiosk visitor sees between two rounds (no
                leaderboard or tasks nav to pass through, unlike the web), so the combo meter has
                to live here too, not just on pane-idle - otherwise the multiplier the next win
                pays is never shown once a first round has been played. */}
            {IS_KIOSK && <ComboBar streak={profile.streak} compact />}
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
              {!IS_KIOSK && (
                <button type="button" className="btn-lb" onClick={actions.goLeaderboard}>
                  {t('result.lb')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Console({ state, profile, actions, trackRef, onOpenIdentity }) {
  const { t, lang } = useLang();
  const { phase, lev, dir, result, price, identityKnown } = state;
  const isIdle = phase === 'idle';
  const isRunning = phase === 'running';
  const isResult = phase === 'result';
  // The up/down buttons are live only in 'idle', on the kiosk exactly as on the web: a locked
  // prediction (running) and the verdict pane (result) both lock them. The Play Again button in
  // the result pane is what resets the phase back to 'idle' before the next round can start.
  const locked = !isIdle;
  const noPrice = price == null;
  const win = isResult && result?.outcome === 'win';
  const broke = isIdle && maxAffordableLever(profile.coins) === null;
  const onGold = !isResult;
  const signupDone = !!readSignup();
  const [signupFor, setSignupFor] = useState(null); // 'signup_broke' | 'signup_trader' | null
  // The signup task's reward (docs/layers.md C5): from the server's own tasks frame once it has
  // arrived (state.tasksRows), the offline-only fallback otherwise - never a number baked into
  // this file.
  const signupReward = state.tasksRows.find((r) => r.id === 'signup')?.reward ?? FALLBACK_SIGNUP_REWARD;

  // Offer the signup once when the player first reaches the Trader level:
  // a proud moment for a good player who never goes broke.
  // Kiosk visitors never see this either - no lead capture in kiosk mode (docs/layers.md).
  const emailAsked = !!readLead() || !!profile.prompts.email_win;
  const traderPrompt =
    !IS_KIOSK &&
    isResult &&
    result?.outcome === 'win' &&
    emailAsked && // never stack on the first-win email prompt
    !signupDone &&
    !profile.prompts.signup_trader &&
    levelFor(profile.record).id === SIGNUP_PROMPT_LEVEL;
  // G1 fix (ticket B6+B7+B9): this used to always open the broker SignupForm, whose "done"
  // unconditionally called claim_task('signup') - a dead end for an unverified player, who the
  // server always refused (first email_required, now not_claimable since signup is no longer a
  // client-claimable task kind at all - db/schema.sql's claim_task, decision 5). The signup
  // reward is granted server-side by verify_otp_code once verified (decision 4), so an
  // unverified player reaching this prompt goes to the OTP screen instead; a verified player
  // (whose signup reward already landed there) still sees the broker SignupForm.
  useEffect(() => {
    if (!traderPrompt || signupFor) return;
    // Unknown identity: wait for the server instead of acting. Opening the OTP screen on a
    // verified player - and burning the once-only prompt on the way - is exactly the
    // wrong-person ask mayAskEmail exists to prevent; this effect re-runs the moment
    // identityKnown flips and picks the right branch then.
    if (!identityKnown) return;
    if (profile.emailVerified) {
      setSignupFor('signup_trader');
    } else {
      actions.markPrompt('signup_trader');
      onOpenIdentity();
    }
  }, [traderPrompt, signupFor, identityKnown, profile.emailVerified, actions, onOpenIdentity]);

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
  // C7: the broke overlay itself now carries the free-refill/tasks/verify-email copy - showing
  // this hint underneath too just doubled up with "Not enough coins" bleeding through the
  // overlay's translucent background under the extra CTA lines (docs/reports/c6-c7 screenshots).
  if (broke) hint = '';
  else if (isIdle && noPrice) hint = t('feed.waiting');
  else if (isIdle) hint = '';
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

          {/* The web's own broke messaging (signup/refill/tasks/verify CTAs) never applies to a
              kiosk visitor: a kiosk session that runs out of coins ends outright (the full-screen
              BROKE modal in KioskApp.jsx, driven by the server's kiosk_session state), never
              "do a task for more coins" - see docs/layers.md C2.

              C7: never a dead end. The primary CTA is whichever unconditional path is still open
              (the once-only free refill, then the tasks screen) - both work with no email at
              all. Verify-email and the signup bonus are offered as extra links, never gates on
              the primary path: the signup reward is granted server-side once verify_otp_code
              confirms an email (ticket B6+B7+B9 decision 4), so this broker-signup CTA only
              appears once profile.emailVerified is already true - offering it earlier used to
              send the player through SignupForm only to have the server's claim_task reject with
              `email_required`, a dead end G1 (same ticket) closes by sending an unverified
              player to the OTP screen instead. */}
          {!IS_KIOSK && broke && (
            <div className="broke">
              <div className="broke-title">{!profile.freeRefillUsed ? t('game.freeTitle') : t('game.brokeTitle')}</div>
              <div className="broke-sub">{!profile.freeRefillUsed ? t('game.freeSub') : t('game.brokeSub')}</div>
              {!profile.freeRefillUsed ? (
                <button type="button" className="btn-primary" onClick={actions.freeRefill}>
                  {t('game.freeCta', { n: num(ECON.freeRefill, lang) })}
                </button>
              ) : (
                <button type="button" className="btn-primary" onClick={actions.goTasks}>
                  {t('game.brokeCta')}
                </button>
              )}
              {!profile.freeRefillUsed && (
                <button type="button" className="link-btn broke-alt" onClick={actions.goTasks}>
                  {t('game.brokeCta')}
                </button>
              )}
              {mayAskEmail(identityKnown, profile) && (
                <button type="button" className="link-btn broke-alt" onClick={onOpenIdentity}>
                  {t('otp.title')}
                </button>
              )}
              {profile.emailVerified && !signupDone && (
                <button type="button" className="link-btn broke-alt" onClick={() => setSignupFor('signup_broke')}>
                  {t('signup.cta', { n: num(signupReward, lang) })}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {!IS_KIOSK && signupFor && (
        <SignupForm
          source={signupFor}
          balance={profile.coins}
          reward={num(signupReward, lang)}
          // The signup reward is granted server-side by verify_otp_code once verified (ticket
          // B6+B7+B9 decision 4), not by a client claim - this form only shows once
          // profile.emailVerified is already true, so the reward has already landed by now.
          onDone={() => actions.markPrompt(signupFor)}
          onCancel={closeSignup}
        />
      )}
    </section>
  );
}

/* ---------- leaderboard ---------- */

// One fused header card (ticket U2): the cup icon that used to sit next to the "Leaderboard"
// title now sits at the left of the card, then "Leaderboard / by record" and, for whichever
// board is on screen, the tournament's title, date range with time left and prize title - all in
// their existing styles. The prize image is gone entirely. The past/upcoming switcher
// (ticket B1, docs/tasks-marketing-lead.md A3) still lives under the card: `tournament` describes
// the board currently shown (live, or a past/upcoming one once switched to) and `tournaments` is
// the full list every chip is drawn from. No new colours, fonts or components: the chips reuse
// `.lang-btn`, the title/sub reuse `.screen-*`.
function LeaderboardHeader({ tournament, tournaments, selectedId, onSelect }) {
  const { t } = useLang();
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!tournament) return undefined;
    const id = setInterval(() => forceTick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, [tournament]);

  const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const timeLeft = () => {
    if (!tournament) return null;
    const ms = new Date(tournament.ends_at).getTime() - Date.now();
    if (ms <= 0) return t('tournament.ended');
    const hours = Math.ceil(ms / 3600000);
    return hours >= 24
      ? t('tournament.daysLeft', { n: Math.ceil(hours / 24) })
      : t('tournament.hoursLeft', { n: hours });
  };

  const activeId = selectedId ?? tournament?.id ?? null;

  return (
    <div className="lb-tournament">
      <div className="lb-head">
        <span className="lb-head-icon">
          <TrophyIcon stroke={GOLD} size={48} />
        </span>
        <div className="lb-head-info">
          <div className="screen-title">{t('lb.title')}</div>
          <div className="screen-sub">{t('lb.byRecord')}</div>
          {tournament ? (
            <>
              <div className="lb-tournament-title">{tournament.title}</div>
              <div className="lb-tournament-dates">
                {fmtDate(tournament.starts_at)} – {fmtDate(tournament.ends_at)}
                {' · '}
                {timeLeft()}
              </div>
              <div className="lb-tournament-prize-title">{tournament.prize_title}</div>
            </>
          ) : (
            <div className="lb-tournament-none">{t('tournament.none')}</div>
          )}
        </div>
      </div>
      {tournaments.length > 1 && (
        <div className="lb-tournament-switcher">
          {tournaments.map((tt) => (
            <button
              key={tt.id}
              type="button"
              className="lang-btn"
              aria-current={activeId === tt.id ? 'true' : undefined}
              style={
                activeId === tt.id
                  ? { borderColor: 'var(--green)', color: '#fff', background: 'rgba(53,227,111,.18)' }
                  : undefined
              }
              onClick={() => onSelect(tt.id)}
            >
              {tt.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// One badge tier's icon (ticket B3): looked up from the legend by tier id. Renders nothing for
// a row with no tier yet (the offline/no-server demo path, which has no server-computed tiers).
function BadgeIcon({ tier, legend }) {
  const entry = legend?.find((l) => l.tier === tier);
  if (!entry) return null;
  return <img className="lb-badge" src={entry.icon} alt={entry.title} title={entry.title} />;
}

// Rows the trailing loading affordance shows at the end of the list while the next page is in
// flight (ticket: infinite scroll) - a couple of the existing skeleton rows, not a spinner, so
// scrolling further never feels like the list went blank.
const LOAD_MORE_SKELETON_ROWS = 2;

function Leaderboard({
  others,
  apiEnabled,
  page,
  pages,
  loadingMore,
  me,
  legend,
  profile,
  identityKnown,
  guestMode,
  onOpenIdentity,
  tournament,
  tournaments,
  onSelectTournament,
  onLoadMore,
}) {
  const { t, lang } = useLang();
  const you = t('lb.you');
  const [selectedId, setSelectedId] = useState(null);
  const selectTournament = (id) => {
    setSelectedId(id);
    onSelectTournament?.(id);
  };

  // The guest note's placement (ticket U2) is the own-row rule from B2 applied to a logged-out
  // player: below the last listed row while the list fits its container, pinned to the bottom of
  // the list container once the rows overflow it. Rows are absolutely positioned over
  // `.lb-spacer`, so "overflow" is measured from that spacer's height rather than from
  // scrollHeight - the guest row itself never counts toward the content height.
  const rows = others || [];
  const listRef = useRef(null);
  const [listOverflows, setListOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) {
      setListOverflows(false);
      return undefined;
    }
    const measure = () => {
      const spacer = el.querySelector('.lb-spacer');
      const content = spacer ? spacer.getBoundingClientRect().height : 0;
      setListOverflows(content > el.clientHeight + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows.length]);

  // Infinite scroll (replaces the old Prev/Next pager): a sentinel sits right after the last
  // row inside `.lb-list`, scoped as the IntersectionObserver's own root so it fires from that
  // element's scroll position rather than the page's. `hasMore` stops it once every page is
  // loaded; the fetch itself is guarded against overlapping calls in src/useGame.js's
  // loadMoreLeaderboard, so a sentinel that is still on screen when a load finishes just fires
  // again for the next page.
  const hasMore = apiEnabled && (page || 1) < (pages || 1);
  const sentinelRef = useRef(null);
  useEffect(() => {
    const root = listRef.current;
    const target = sentinelRef.current;
    if (!root || !target || !hasMore) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore?.();
      },
      { root, rootMargin: '200px 0px' },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [hasMore, onLoadMore]);

  // The no-server demo path (VITE_GAME_WS unset - a preview build or local UI work with no
  // backend, src/api/client.js): `others` is the static dummy list, with no rank, tier or
  // server-computed `me` to page or badge. Keep the old synthetic "you" row for that case only;
  // every real path (guest or verified, ticket B2) is server-paged below.
  if (!apiEnabled) {
    const entries = [...others.map((o) => ({ ...o, me: false })), { name: you, s: profile.record, me: true }];
    const sorted = [...entries].sort((a, b) => b.s - a.s);
    return (
      <section className="lb">
        <LeaderboardHeader
          tournament={tournament}
          tournaments={tournaments}
          selectedId={selectedId}
          onSelect={selectTournament}
        />
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
      </section>
    );
  }

  // `others` is null until the leaderboard's first fetch or push lands (src/useGame.js's
  // initialGame) - distinct from `[]`, which means the fetch landed and there is genuinely
  // nothing to show. Only the "no data yet" case gets the skeleton; an empty board falls
  // through to the normal server-paged render below, which already handles zero rows (the
  // guest CTA row, or just an empty list for a verified player on an empty board).
  if (others == null) {
    return (
      <section className="lb">
        <LeaderboardHeader
          tournament={tournament}
          tournaments={tournaments}
          selectedId={selectedId}
          onSelect={selectTournament}
        />
        <div className="lb-list">
          <div className="lb-spacer" style={{ '--n': 7 }} />
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="lb-row lb-row-skeleton" style={{ '--i': i }}>
              <span className="lb-skel lb-skel-rank" />
              <span className="lb-skel lb-skel-name" />
              <span className="lb-skel lb-skel-score" />
            </div>
          ))}
        </div>
        {/* The ad zone used to sit only in the loaded-rows return below, so it never even started
            fetching its banner list until the leaderboard's own row data had landed - stacking
            its latency on top of the game server round trip instead of racing it. It has no
            dependency on `others`, so it renders here too and starts warm (see App.jsx's
            warmBanners()) the moment this skeleton shows. */}
        <AdZone />
      </section>
    );
  }

  // Server-paged rows (ticket B2): each row already carries its own rank and badge tier from
  // public.leaderboard(). `me` is this player's own row from public.my_rank(), matched by
  // player id, never the masked display string (closes gap G3); null for a guest/unverified
  // player, who sees the guest CTA row instead.
  const ownRowOnPage = me != null && rows.some((r) => r.rank === me.rank);
  const guest = guestMode && me == null;

  return (
    <section className="lb">
      <LeaderboardHeader
        tournament={tournament}
        tournaments={tournaments}
        selectedId={selectedId}
        onSelect={selectTournament}
      />
      <div className="lb-list" ref={listRef}>
        <div className="lb-spacer" style={{ '--n': rows.length + (loadingMore ? LOAD_MORE_SKELETON_ROWS : 0) }} />
        {rows.map((r, i) => {
          const mine = me != null && r.rank === me.rank;
          // Score-desync fix: rank/display/tier only exist server-side (this row's position
          // depends on every other player's own score, which the client cannot know), but the
          // number itself is exactly profile.record once this is the player's own row - reading
          // it from `profile` instead of this row's own snapshot means it is always as fresh as
          // the topbar, never lagging behind a reward the client already knows about but this
          // board has not been re-fetched since.
          const score = mine ? profile.record : r.record;
          return (
            <div key={r.rank} className={mine ? 'lb-row lb-row-me' : 'lb-row'} style={{ '--i': i }}>
              <span className="lb-rank">{num(r.rank, lang)}</span>
              <span className="lb-name" dir="ltr">
                {r.display}
                <BadgeIcon tier={r.tier} legend={legend} />
              </span>
              <span className="lb-score">{num(score, lang)}</span>
            </div>
          );
        })}
        {/* The loading affordance for the next page (ticket: infinite scroll): a couple of the
            same skeleton rows the initial load uses, appended after the real rows rather than a
            spinner - kept honest by loadingMore, never shown once the fetch lands or fails. */}
        {loadingMore &&
          Array.from({ length: LOAD_MORE_SKELETON_ROWS }, (_, k) => (
            <div key={`more-${k}`} className="lb-row lb-row-skeleton" style={{ '--i': rows.length + k }}>
              <span className="lb-skel lb-skel-rank" />
              <span className="lb-skel lb-skel-name" />
              <span className="lb-skel lb-skel-score" />
            </div>
          ))}
        {hasMore && <div ref={sentinelRef} className="lb-sentinel" aria-hidden="true" />}
        {/* Unverified web players never get a synthetic score row - the leaderboard is exactly
            where the ticket asks for the guest prompt instead (docs/layers.md C3, C4). It sits
            below the last listed row while the list fits (ticket U2). */}
        {guest && !listOverflows && (
          <button
            type="button"
            className="lb-row lb-row-me lb-row-guest"
            style={{ '--i': rows.length + (loadingMore ? LOAD_MORE_SKELETON_ROWS : 0) }}
            onClick={onOpenIdentity}
          >
            <span className="lb-name">{t('lb.guestNote')}</span>
          </button>
        )}
      </div>
      {/* Pinned to the bottom of the list container when the rows do not fit (ticket U2's guest
          note) or whenever `me`'s rank is not one of the rows on the current page (ticket B2
          decision 4, docs/tasks-marketing-lead.md A2). */}
      {guest && listOverflows && (
        <button
          type="button"
          className="lb-row lb-row-me lb-row-sticky lb-row-guest"
          onClick={onOpenIdentity}
        >
          <span className="lb-name">{t('lb.guestNote')}</span>
        </button>
      )}
      {me != null && !ownRowOnPage && (
        <div className="lb-row lb-row-me lb-row-sticky">
          <span className="lb-rank">{num(me.rank, lang)}</span>
          <span className="lb-name" dir="ltr">
            {me.display}
            <BadgeIcon tier={me.tier} legend={legend} />
          </span>
          {/* Same reasoning as the in-page own row above: the number is profile.record, not
              this snapshot's own me.record. */}
          <span className="lb-score">{num(profile.record, lang)}</span>
        </div>
      )}
      {legend?.length > 0 && (
        <div className="lb-legend">
          {legend.map((l) => (
            <div key={l.tier} className="lb-legend-item">
              <img className="lb-legend-icon" src={l.icon} alt="" />
              <span className="lb-legend-title">{l.title}</span>
            </div>
          ))}
        </div>
      )}
      {/* The board's own `me` reply can land before this session's get_me does (they are two
          separate requests over one socket), so `me != null` is never proof of an unverified
          player - mayAskEmail waits for the server's own identity answer before offering the
          capture to a ranked player it KNOWS has no verified email. */}
      {me != null && me.rank <= 10 && mayAskEmail(identityKnown, profile) && !readLead() && (
        <LeadCapture
          source="leaderboard"
          balance={profile.coins}
          variant="slim"
          title={t('lead.lbTitle')}
          subtitle={t('lead.lbSub')}
        />
      )}
      {/* Ticket B11: bottom 40% ad zone, web only - renders nothing when the list is empty or
          the fetch fails, so .lb-list above simply keeps the full height (flex:1 in styles.css). */}
      <AdZone />
    </section>
  );
}

/* ---------- nav ---------- */

function Nav({ screen, actions, onNavigate }) {
  const { t } = useLang();
  // 'game' never guards: tapping Play while already on the play screen is not a navigation away
  // (startGame's own patch is a no-op there), so it skips the confirmation a live round would
  // otherwise trigger for every other tab (ticket: nav-on-play).
  const items = [
    { id: 'home', label: t('nav.home'), Icon: HomeIcon, go: actions.goHome, guarded: true },
    { id: 'game', label: t('nav.play'), Icon: GamepadIcon, go: actions.startGame, guarded: false },
    { id: 'tasks', label: t('nav.tasks'), Icon: GiftIcon, go: actions.goTasks, guarded: true },
    { id: 'lb', label: t('nav.lb'), Icon: TrophyIcon, go: actions.goLeaderboard, guarded: true },
  ];
  return (
    <nav className="nav">
      {items.map(({ id, label, Icon, go, guarded }) => {
        const active = screen === id;
        return (
          <button
            key={id}
            type="button"
            className="nav-btn"
            aria-current={active ? 'page' : undefined}
            style={{ color: active ? '#fff' : DIM }}
            onClick={() => (guarded ? onNavigate(go) : go())}
          >
            <Icon stroke={active ? GREEN : DIM} />
            {label}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Ticket nav-on-play: the nav bar is reachable on the play screen now, so an accidental tap mid-
 * round could otherwise cost a player their stake. Same modal chrome as Profile.jsx's
 * ConfirmSignOut - title, a line saying what actually happens, cancel as the filled ghost, the
 * disruptive choice outlined - and the same "say what they lose" tone, not "Are you sure?".
 */
function ConfirmLeaveRound({ stake, onCancel, onConfirm }) {
  const { t, lang } = useLang();
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('leaveRound.title')}>
      <div className="modal">
        <div className="modal-title">{t('leaveRound.title')}</div>
        <div className="modal-sub">{t('leaveRound.body', { n: num(stake, lang) })}</div>
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            {t('leaveRound.cancel')}
          </button>
          <button type="button" className="btn-signout" onClick={onConfirm}>
            {t('leaveRound.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- app ---------- */

export default function App() {
  const {
    state,
    profile,
    actions,
    trackRef,
    isKiosk,
    tourSeen,
    markTourSeen,
    requestNav,
    pendingNav,
    confirmNav,
    cancelNav,
  } = useGame();
  const boot = useBootReady();
  const { screen } = state;
  const [lang, setLangState] = useState(readStoredLang);
  const [otpOpen, setOtpOpen] = useState(false);
  // The "share your record" mission (Tasks.jsx's 'story' row): tapping it navigates to Profile and
  // opens its share modal instead of granting anything on the tap (see src/Profile.jsx's
  // shareMission handling). Holds the tapped task row while that hand-off is pending; Profile
  // consumes it once on mount so a later, unrelated visit to the profile screen never re-triggers
  // the auto-open.
  const [shareMissionRow, setShareMissionRow] = useState(null);
  // A guest is a web player (never a kiosk, which never shows email or the leaderboard at all)
  // who the SERVER has said has no verified email (docs/layers.md C3, C4). mayAskEmail keeps the
  // guest row - and every other ask - silent during the connect window: /board is deep-linkable,
  // so a verified user can be standing on this screen before the session's own `me` row lands.
  const guestMode = apiEnabled && !isKiosk && mayAskEmail(state.identityKnown, profile);
  // The tour's verify card is an ask like any other (see TOUR_CARDS_NO_VERIFY): it only exists
  // while the server's answer says this player has no verified email.
  const tourCards = mayAskEmail(state.identityKnown, profile) ? TOUR_CARDS : TOUR_CARDS_NO_VERIFY;

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

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = 'ltr';
  }, [lang]);

  // Leaderboard ads (ticket: ad zone latency fix): the kiosk never shows the ad zone at all, so
  // never spend a player's data on it there. On the web, fire the banner list fetch and warm each
  // banner's ~1 MB creative as early as the app itself mounts - on Home, well before a player taps
  // into the leaderboard - so by the time AdZone renders, its fetch (src/ads.jsx's loadBanners)
  // resolves from an already-settled promise and the iframe loads from a warm cache instead of a
  // cold multi-hundred-KB-to-MB-sized network fetch.
  useEffect(() => {
    if (IS_KIOSK) return;
    warmBanners();
  }, []);

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
      <div className={IS_KIOSK ? 'app app-kiosk' : 'app'} dir="ltr" data-lang={lang}>
        <div className="phone" ref={phoneRef}>
          {IS_KIOSK ? (
            // The booth visitor flow is a separate tree, not a screen among the web's home/
            // game/lb/tasks - it never mounts Home, Leaderboard, Tasks, Nav, LeadCapture,
            // SignupForm or the identity bar (docs/layers.md C2's hard guarantee), it just
            // reuses TopBar and Console from here for the chrome and the play screen itself.
            <KioskApp state={state} profile={profile} actions={actions} trackRef={trackRef} />
          ) : (
            <>
              <TopBar
                profile={profile}
                actions={actions}
                active={screen === 'profile'}
                identityKnown={state.identityKnown}
                onSignIn={() => setOtpOpen(true)}
                onNavigate={requestNav}
              />
              {screen === 'home' && <Home profile={profile} actions={actions} />}
              {screen === 'game' && (
                <Console
                  state={state}
                  profile={profile}
                  actions={actions}
                  trackRef={trackRef}
                  onOpenIdentity={() => setOtpOpen(true)}
                />
              )}
              {screen === 'lb' && (
                <Leaderboard
                  others={state.others}
                  apiEnabled={apiEnabled}
                  page={state.page}
                  pages={state.pages}
                  loadingMore={state.lbLoadingMore}
                  me={state.me}
                  legend={state.legend}
                  profile={profile}
                  identityKnown={state.identityKnown}
                  guestMode={guestMode}
                  onOpenIdentity={() => setOtpOpen(true)}
                  tournament={state.tournament}
                  tournaments={state.tournaments}
                  onSelectTournament={actions.selectTournament}
                  onLoadMore={actions.loadMoreLeaderboard}
                />
              )}
              {screen === 'profile' && (
                <Profile
                  profile={profile}
                  identityKnown={state.identityKnown}
                  actions={actions}
                  onToast={(txt) => actions.toast?.(txt)}
                  shareMission={
                    shareMissionRow && {
                      pending: true,
                      reward: shareMissionRow.reward,
                      onConsumed: () => setShareMissionRow(null),
                      onClaim: () => actions.claimTask(shareMissionRow.id),
                    }
                  }
                />
              )}
              {screen === 'tasks' && (
                <Tasks
                  tasksRows={state.tasksRows}
                  onClaim={actions.claimTask}
                  onRefreshTasks={actions.refreshTasks}
                  onReportVideoProgress={actions.reportVideoProgress}
                  onStartTaskVisit={actions.startTaskVisit}
                  onReturnTaskVisit={actions.returnTaskVisit}
                  onInstagramStart={actions.instagramStart}
                  onInstagramCheck={actions.instagramCheck}
                  ourInstagramHandle={state.ourInstagramHandle}
                  onOpenIdentity={() => setOtpOpen(true)}
                  onShareMission={(row) => {
                    setShareMissionRow(row);
                    actions.goProfile();
                  }}
                  onToast={(txt) => actions.toast?.(txt)}
                />
              )}
              <Nav screen={screen} actions={actions} onNavigate={requestNav} />
            </>
          )}
          <Toast toast={state.toast} />
          <UpdateBanner />
          {otpOpen && (
            <OtpModal
              onRequestOtp={actions.requestOtp}
              onVerifyOtp={actions.verifyOtp}
              onClose={() => setOtpOpen(false)}
            />
          )}
          {!isKiosk && !tourSeen && <TourPlaceholder cards={tourCards} onDone={markTourSeen} />}
          <ConnectionModal feed={state.feed} />
          {!isKiosk && pendingNav && (
            <ConfirmLeaveRound stake={stakeFor(state.lev)} onCancel={cancelNav} onConfirm={confirmNav} />
          )}
        </div>
        {/* Last child of .app so it covers the phone frame and everything in it, including the
            first-visit tour - the tour is the first thing a new player should see, but only once
            the app behind it is real. */}
        {!boot.gone && <Splash leaving={boot.leaving} />}
      </div>
    </LangContext.Provider>
  );
}
