import { useState } from 'react';
import { COMBO_MAX, comboMult, ECON, LEVELS, levelFor, nextLevel } from './config.js';
import { num, useLang } from './i18n.js';
import { readLead, readSignup } from './leads.js';
import ShareModal from './ShareModal.jsx';

const BADGES = ['high_roller', 'hot_streak', 'comeback'];
const BADGE_ICON = { high_roller: '◆', hot_streak: '🔥', comeback: '↺' };

/** Two-letter initials for the avatar, from the signup name or "You". */
export function initialsOf(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return 'Y';
  return parts
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
}

function ProgressRing({ pct, size = 84, stroke = 7, children }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, pct)) * c;
  return (
    <div className="pf-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="url(#pf-grad)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <defs>
          <linearGradient id="pf-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#35e36f" />
            <stop offset="1" stopColor="#e9b62a" />
          </linearGradient>
        </defs>
      </svg>
      <div className="pf-ring-inner">{children}</div>
    </div>
  );
}

export default function Profile({ profile, actions, onToast }) {
  const { t, lang } = useLang();
  const signup = readSignup();
  const lead = readLead();
  const level = levelFor(profile.record);
  const next = nextLevel(profile.record);
  const levelIdx = LEVELS.findIndex((l) => l.id === level.id);
  const from = level.min;
  const to = next ? next.min : level.min;
  const pct = next ? (profile.record - from) / (to - from) : 1;
  const winRate = profile.rounds ? Math.round((profile.wins / profile.rounds) * 100) : 0;
  const name = signup?.name || t('profile.guest');
  const [confirmReset, setConfirmReset] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <section className="pf">
      <div className="pf-head">
        <ProgressRing pct={pct}>
          <div className="pf-avatar" aria-hidden="true">
            {initialsOf(signup?.name)}
          </div>
        </ProgressRing>
        <div className="pf-id">
          <div className="pf-name">{name}</div>
          <div className="pf-level">
            <span className="pf-level-chip">{t(`level.${level.id}`)}</span>
            <span className="pf-level-sub">
              {next
                ? t('profile.toNext', { n: num(next.min - profile.record, lang), level: t(`level.${next.id}`) })
                : t('home.maxLevel')}
            </span>
          </div>
          <div className="pf-levels" aria-hidden="true">
            {LEVELS.map((l, i) => (
              <span key={l.id} className={`pf-lv ${i <= levelIdx ? 'pf-lv-on' : ''}`} title={t(`level.${l.id}`)} />
            ))}
          </div>
        </div>
      </div>

      <div className="pf-tiles">
        <div className="pf-tile pf-tile-gold">
          <div className="pf-k">{t('profile.coins')}</div>
          <div className="pf-v" dir="ltr">
            {num(profile.coins, lang)}
          </div>
        </div>
        <div className="pf-tile pf-tile-green">
          <div className="pf-k">{t('record')}</div>
          <div className="pf-v" dir="ltr">
            {num(profile.record, lang)}
          </div>
        </div>
        <div className="pf-tile">
          <div className="pf-k">{t('profile.rounds')}</div>
          <div className="pf-v" dir="ltr">
            {num(profile.rounds, lang)}
          </div>
        </div>
        <div className="pf-tile">
          <div className="pf-k">{t('profile.winRate')}</div>
          <div className="pf-v" dir="ltr">
            {num(winRate, lang)}%
          </div>
        </div>
        <div className="pf-tile">
          <div className="pf-k">{t('profile.bestCombo')}</div>
          <div className="pf-v" dir="ltr">
            ×{num(comboMult(profile.bestStreak), lang)}
          </div>
        </div>
        <div className="pf-tile">
          <div className="pf-k">{t('profile.combo')}</div>
          <div className="pf-v" dir="ltr">
            {profile.streak > 0 ? '🔥 ' : ''}×{num(comboMult(profile.streak), lang)}
            <span className="pf-v-sub">/ ×{num(COMBO_MAX, lang)}</span>
          </div>
        </div>
      </div>

      <div className="pf-section">
        <div className="pf-section-title">{t('profile.badges')}</div>
        <div className="pf-badges">
          {BADGES.map((b) => {
            const on = profile.badges.includes(b);
            return (
              <div key={b} className={`pf-badge ${on ? 'pf-badge-on' : ''}`} title={t(`profile.badgeHint.${b}`)}>
                <span className="pf-badge-icon" aria-hidden="true">
                  {BADGE_ICON[b]}
                </span>
                <span className="pf-badge-name">{t(`profile.badge.${b}`)}</span>
                <span className="pf-badge-hint">{on ? t('profile.earned') : t(`profile.badgeHint.${b}`)}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="pf-section">
        <div className="pf-section-title">{t('profile.account')}</div>
        <div className="pf-rows">
          <div className="pf-row">
            <span className="pf-row-k">{t('profile.email')}</span>
            {lead ? (
              <span className="pf-row-v pf-ok" dir="ltr">
                {lead.email}
              </span>
            ) : (
              <button type="button" className="pf-link" onClick={actions.goTasks}>
                {t('profile.addEmail')}
              </button>
            )}
          </div>
          <div className="pf-row">
            <span className="pf-row-k">{t('profile.xchief')}</span>
            {signup ? (
              <span className="pf-row-v pf-ok">{t('profile.linked')}</span>
            ) : (
              <button type="button" className="pf-link" onClick={actions.goTasks}>
                {t('profile.openAccount', { n: num(1000, lang) })}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="pf-actions">
        <button type="button" className="btn-primary pf-btn" onClick={() => setShareOpen(true)}>
          {t('profile.share')}
        </button>
        {confirmReset ? (
          <button
            type="button"
            className="btn-ghost pf-btn pf-danger"
            onClick={() => {
              actions.resetProfile();
              setConfirmReset(false);
            }}
          >
            {t('profile.resetConfirm')}
          </button>
        ) : (
          <button type="button" className="btn-ghost pf-btn" onClick={() => setConfirmReset(true)}>
            {t('profile.reset')}
          </button>
        )}
      </div>
      <div className="pf-foot">{t('profile.foot', { n: num(ECON.startCoins, lang) })}</div>
      {shareOpen && (
        <ShareModal
          profile={profile}
          onClose={() => setShareOpen(false)}
          onToast={(txt) => onToast?.(txt)}
        />
      )}
    </section>
  );
}
