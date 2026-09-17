import { useEffect, useRef, useState } from 'react';
import { LINKS_PUBLIC } from './config.js';
import { useLang } from './i18n.js';
import { readLead, readSignup, registerUrl, submitSignup } from './leads.js';

/**
 * In-game xChief signup: email only (ticket B4, docs/tasks-marketing-lead.md ground rules:
 * "Only the email identifies a web player"). Submitting stores the lead, pays the reward (via
 * onDone) and opens the real registration page with the email prefilled. We cannot verify the
 * external account, so the reward is tied to this form, which we can.
 *
 * variant: 'modal' (overlay) | 'inline' (inside a task row)
 */
export default function SignupForm({ source, balance, reward, variant = 'modal', onDone, onCancel }) {
  const { t, lang } = useLang();
  const lead = readLead();
  const [email, setEmail] = useState(lead?.email || '');
  const [error, setError] = useState('');
  const [done, setDone] = useState(() => !!readSignup());
  const firstRef = useRef(null);

  useEffect(() => {
    if (variant === 'modal') firstRef.current?.focus();
  }, [variant]);

  useEffect(() => {
    if (!error) return undefined;
    const id = setTimeout(() => setError(''), 2600);
    return () => clearTimeout(id);
  }, [error]);

  const submit = (e) => {
    e.preventDefault();
    const em = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) return setError(t('signup.errEmail'));
    submitSignup({ email: em, source, balance, lang, page: window.location.pathname });
    setDone(true);
    onDone?.();
    // Open the real registration with the email prefilled. Done after the
    // state update so the reward shows even if the popup is blocked.
    window.open(registerUrl(LINKS_PUBLIC.demo, { email: em }), '_blank', 'noopener');
  };

  const body = done ? (
    <div className="signup-done" role="status">
      <div className="signup-done-title">{t('signup.doneTitle')}</div>
      <div className="signup-done-sub">{t('signup.doneSub')}</div>
      <a
        className="btn-primary signup-open"
        href={registerUrl(LINKS_PUBLIC.demo, readSignup() || {})}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t('signup.open')}
      </a>
      {onCancel && (
        <button type="button" className="btn-ghost" onClick={onCancel}>
          {t('signup.back')}
        </button>
      )}
    </div>
  ) : (
    <form className="signup-form" onSubmit={submit} noValidate autoComplete="on">
      <div className="signup-head">
        <div className="signup-title">{t('signup.title')}</div>
        <div className="signup-sub">{t('signup.sub', { n: reward })}</div>
      </div>
      <input
        ref={firstRef}
        className="lead-input"
        type="email"
        name="email"
        autoComplete="email"
        inputMode="email"
        autoCapitalize="none"
        placeholder={t('signup.email')}
        aria-label={t('signup.email')}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        dir="ltr"
        required
      />
      <div className="lead-foot signup-foot" aria-live="polite">
        {error ? <span className="lead-error">{error}</span> : t('signup.privacy')}
      </div>
      <div className="signup-actions">
        {onCancel && (
          <button type="button" className="btn-ghost" onClick={onCancel}>
            {t('signup.notNow')}
          </button>
        )}
        <button type="submit" className="btn-primary">
          {t('signup.cta', { n: reward })}
        </button>
      </div>
    </form>
  );

  if (variant === 'inline') return <div className="signup signup-inline">{body}</div>;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('signup.title')}>
      <div className="modal signup">{body}</div>
    </div>
  );
}
