import { useEffect, useState } from 'react';
import { COMBO_MAX, comboMult, LEVELS, levelFor, nextLevel } from './config.js';
import { num, useLang } from './i18n.js';
import { mayAskEmail, readLead, readSignup } from './leads.js';
import ShareModal from './ShareModal.jsx';

const BADGES = ['high_roller', 'hot_streak', 'comeback'];
const BADGE_ICON = { high_roller: '◆', hot_streak: '🔥', comeback: '↺' };

/** The avatar glyph (ticket U1): one icon for the top bar and the profile disc. currentColor
 * lets each host pick its own stroke - the top bar's --gold, the gold profile disc's own dark
 * ink - with no new colour token and no initials left to compute. */
export function UserIcon({ size = 24 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
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

export default function Profile({ profile, identityKnown, actions, onToast, shareMission }) {
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

  // The "share your record" mission (Tasks.jsx's 'story' row -> App.jsx) lands here with
  // shareMission.pending true and opens this same share modal automatically instead of granting
  // on the tap that got us here. Snapshot it once at mount: App clears its own pending flag right
  // after (so a later, unrelated visit to this screen never re-triggers it), but the modal needs
  // a stable reward/onClaim pair for as long as it stays open on this visit.
  const [missionSnapshot] = useState(() =>
    shareMission?.pending ? { reward: shareMission.reward, onClaim: shareMission.onClaim } : null,
  );
  const [shareOpen, setShareOpen] = useState(!!missionSnapshot);
  const [signOutOpen, setSignOutOpen] = useState(false);
  useEffect(() => {
    if (missionSnapshot) shareMission.onConsumed?.();
    // Runs once on mount only - shareMission is read from the closure captured above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="pf">
      <div className="pf-head">
        <ProgressRing pct={pct}>
          <div className="pf-avatar" aria-hidden="true">
            <UserIcon size={48} />
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
            {/* The server's own verified address wins over any local marketing lead: a verified
                player is never offered "Add email" again, masked exactly like the identity bar
                (docs/layers.md C3). mayAskEmail then keeps the button itself silent until the
                server has said this player has no verified email - during the connect window
                the row shows neither an address nor an ask. */}
            {profile.emailVerified && profile.display ? (
              <span className="pf-row-v pf-ok" dir="ltr">
                {profile.display}
              </span>
            ) : lead ? (
              <span className="pf-row-v pf-ok" dir="ltr">
                {lead.email}
              </span>
            ) : (
              mayAskEmail(identityKnown, profile) && (
                <button type="button" className="pf-link" onClick={actions.goTasks}>
                  {t('profile.addEmail')}
                </button>
              )
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
        {/* Only a signed-in player has anything to sign out of. This is the single sign-out in
            the app - it used to be a text link in a header strip above every screen, which cost
            a row of vertical space everywhere to offer an action almost nobody takes. */}
        {profile.emailVerified && (
          <button type="button" className="pf-btn btn-signout" onClick={() => setSignOutOpen(true)}>
            {t('profile.signOut')}
          </button>
        )}
      </div>
      <div className="pf-foot">{t('profile.foot')}</div>
      {shareOpen && (
        <ShareModal
          profile={profile}
          onClose={() => setShareOpen(false)}
          onToast={(txt) => onToast?.(txt)}
          mission={missionSnapshot}
        />
      )}
      {signOutOpen && (
        <ConfirmSignOut
          email={profile.display || profile.email}
          onCancel={() => setSignOutOpen(false)}
          onConfirm={actions.signOut}
        />
      )}
    </section>
  );
}

/**
 * Sign-out is not undoable from the player's side: the token is revoked server-side, this phone
 * becomes a new player, and the missions already taken on it stay taken (they are capped per
 * device, not per player). So it asks first, and the asking says what will actually happen
 * rather than "are you sure?".
 *
 * Same modal chrome as ShareModal - no new dialog shape for one question.
 */
function ConfirmSignOut({ email, onCancel, onConfirm }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('profile.signOut')}>
      <div className="modal">
        <div className="modal-title">{t('profile.signOutTitle')}</div>
        <div className="modal-sub">{t('profile.signOutBody')}</div>
        <div className="modal-sub">{t('profile.signOutKeep', { email })}</div>
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
            {t('profile.signOutCancel')}
          </button>
          <button
            type="button"
            className="btn-signout"
            disabled={busy}
            onClick={() => {
              // The revoke is a round trip and the reload only happens after it lands, so without
              // this the player can press twice and fire two of them.
              setBusy(true);
              onConfirm();
            }}
          >
            {t('profile.signOutConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
