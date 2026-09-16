import { useEffect, useRef, useState } from 'react';
import { num, useLang } from './i18n.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RESEND_COOLDOWN_MS = 30000;

function errorText(t, code) {
  const key = `otp.errors.${code || 'default'}`;
  const msg = t(key);
  return msg === key ? t('otp.errors.default') : msg;
}

/**
 * The header's web identity line (docs/layers.md C3): once verified, the masked email and a
 * Sign out. Reuses the topbar's own row layout and the lead-capture "skip" button - no new
 * classes, no new colours. Renders nothing for a guest; the entry point into OtpModal lives on
 * the leaderboard screen instead ("play as guest - add your email to be ranked" is specifically
 * where the leaderboard would show them, not the header).
 */
export function IdentityBar({ profile, onSignOut }) {
  const { t } = useLang();
  if (!(profile.emailVerified && profile.display)) return null;
  return (
    <div className="topbar identity-bar">
      <span className="screen-sub">
        {t('identity.playingAs', { email: profile.display })} · {t('identity.savedNote')}
      </span>
      <button type="button" className="lead-skip" onClick={onSignOut}>
        {t('identity.signOut')}
      </button>
    </div>
  );
}

/**
 * The OTP entry screen (docs/layers.md C3): email -> 8-digit code -> done. Every class here is
 * lifted from an existing modal (Tasks.jsx's PinModal, SignupForm's own done state) - design
 * fidelity rule, no new components or styles.
 *
 * onRequestOtp/onVerifyOtp are the server round trips (useGame.js's actions.requestOtp/
 * verifyOtp); this component owns only its own step/error/resend-timer UI state, never a
 * verdict - onVerifyOtp's resolution IS the server's answer, shown as-is.
 */
export default function OtpModal({ onRequestOtp, onVerifyOtp, onClose }) {
  const { t, lang } = useLang();
  const [step, setStep] = useState('email'); // 'email' | 'code'
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [step]);

  // Only ticks while the resend link can still be disabled - no timer running once it is live.
  useEffect(() => {
    if (step !== 'code' || Date.now() >= resendAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [step, resendAt]);

  const sendCode = (em) => {
    setBusy(true);
    setError('');
    onRequestOtp(em)
      .then(() => {
        setStep('code');
        setCode('');
        setResendAt(Date.now() + RESEND_COOLDOWN_MS);
      })
      .catch((err) => setError(errorText(t, err?.code)))
      .finally(() => setBusy(false));
  };

  const submitEmail = (e) => {
    e.preventDefault();
    const em = email.trim().toLowerCase();
    if (!EMAIL_RE.test(em)) {
      setError(errorText(t, 'invalid_email'));
      return;
    }
    setEmail(em);
    sendCode(em);
  };

  const submitCode = (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    onVerifyOtp(email, code)
      .then((me) => setResult(me))
      .catch((err) => {
        setError(errorText(t, err?.code));
        setCode('');
        inputRef.current?.focus();
      })
      .finally(() => setBusy(false));
  };

  const resend = () => {
    if (busy || Date.now() < resendAt) return;
    sendCode(email);
  };

  const resendLeft = Math.max(0, Math.ceil((resendAt - now) / 1000));

  if (result) {
    return (
      <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('otp.doneTitle')}>
        <div className="modal">
          <div className="signup-done" role="status">
            <div className="signup-done-title">
              {result.identityChanged ? t('identity.welcomeBack') : t('otp.doneTitle')}
            </div>
            <div className="signup-done-sub">{t('identity.playingAs', { email: result.display })}</div>
            <div className="signup-done-sub">{t('otp.doneRecord', { n: num(result.record, lang) })}</div>
            <button type="button" className="btn-primary" onClick={onClose}>
              {t('otp.close')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('otp.title')}>
      <div className="modal">
        {step === 'email' ? (
          <form onSubmit={submitEmail} noValidate>
            <div className="modal-title">{t('otp.title')}</div>
            <div className="modal-sub">{error ? <span className="lead-error">{error}</span> : t('otp.emailSub')}</div>
            <input
              ref={inputRef}
              className="lead-input"
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={t('otp.emailPlaceholder')}
              aria-label={t('otp.emailPlaceholder')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              dir="ltr"
              required
            />
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={onClose}>
                {t('otp.cancel')}
              </button>
              <button type="submit" className="btn-primary" disabled={busy}>
                {t('otp.send')}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={submitCode} noValidate>
            <div className="modal-title">{t('otp.codeTitle')}</div>
            <div className="modal-sub">
              {error ? <span className="lead-error">{error}</span> : t('otp.codeSub', { email })}
            </div>
            <input
              ref={inputRef}
              className="pin-input"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              maxLength={8}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
              aria-label={t('otp.codeTitle')}
            />
            <div className="lead-foot" aria-live="polite">
              <button type="button" className="lead-skip" onClick={resend} disabled={busy || resendLeft > 0}>
                {resendLeft > 0 ? t('otp.resendWait', { s: resendLeft }) : t('otp.resend')}
              </button>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={onClose}>
                {t('otp.cancel')}
              </button>
              <button type="submit" className="btn-primary" disabled={busy || code.length !== 8}>
                {t('otp.verify')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
