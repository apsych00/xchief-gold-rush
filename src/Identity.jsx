import { useEffect, useState } from 'react';
import { num, useLang } from './i18n.js';
import PromptModal from './PromptModal.jsx';

const RESEND_COOLDOWN_MS = 30000;

// The server error -> copy mapping for both OTP steps (unify-email-modal ticket: this is the one
// place that maps an OTP error code to a sentence; PromptModal never duplicates it - every call
// site that can get an OTP-shaped error back passes it through here via PromptModal's mapError).
export function errorText(t, code) {
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
 * The OTP entry screen (docs/layers.md C3): email -> 8-digit code -> done. Both steps render
 * through the one shared PromptModal (unify-email-modal ticket) - same backdrop, same spacing,
 * same reserved error region - so moving from the email field to the code field never looks like
 * two different dialogs. The done screen has no input, so it keeps its own small result card
 * (lifted from SignupForm's own done state, same design-fidelity reuse as before).
 *
 * onRequestOtp/onVerifyOtp are the server round trips (useGame.js's actions.requestOtp/
 * verifyOtp); this component owns only its own step/resend-timer UI state, never a verdict -
 * onVerifyOtp's resolution IS the server's answer, shown as-is.
 */
export default function OtpModal({ onRequestOtp, onVerifyOtp, onClose }) {
  const { t, lang } = useLang();
  const [step, setStep] = useState('email'); // 'email' | 'code'
  const [email, setEmail] = useState('');
  const [resendAt, setResendAt] = useState(0);
  const [resendBusy, setResendBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [result, setResult] = useState(null);

  // Only ticks while the resend link can still be disabled - no timer running once it is live.
  useEffect(() => {
    if (step !== 'code' || Date.now() >= resendAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [step, resendAt]);

  const requestCode = (em) =>
    onRequestOtp(em).then(() => {
      setResendAt(Date.now() + RESEND_COOLDOWN_MS);
    });

  const submitEmail = (em) =>
    requestCode(em).then(() => {
      setEmail(em);
      setStep('code');
    });

  const submitCode = (code) => onVerifyOtp(email, code).then((me) => setResult(me));

  const resendLeft = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const resend = () => {
    if (resendBusy || Date.now() < resendAt) return;
    setResendBusy(true);
    requestCode(email).finally(() => setResendBusy(false));
  };

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

  if (step === 'email') {
    return (
      <PromptModal
        resetKey="email"
        title={t('otp.title')}
        subtitle={t('otp.emailSub')}
        fieldType="email"
        placeholder={t('otp.emailPlaceholder')}
        submitLabel={t('otp.send')}
        cancelLabel={t('otp.cancel')}
        onSubmit={submitEmail}
        onCancel={onClose}
        mapError={(err) => errorText(t, err?.code)}
        dialogLabel={t('otp.title')}
      />
    );
  }

  return (
    <PromptModal
      resetKey={`code-${resendAt}`}
      title={t('otp.codeTitle')}
      subtitle={t('otp.codeSub', { email })}
      fieldType="code"
      codeLength={8}
      ariaLabel={t('otp.codeTitle')}
      submitLabel={t('otp.verify')}
      cancelLabel={t('otp.cancel')}
      onSubmit={submitCode}
      onCancel={onClose}
      mapError={(err) => errorText(t, err?.code)}
      dialogLabel={t('otp.codeTitle')}
      footer={
        <div className="lead-foot" aria-live="polite">
          <button type="button" className="lead-skip" onClick={resend} disabled={resendBusy || resendLeft > 0}>
            {resendLeft > 0 ? t('otp.resendWait', { s: resendLeft }) : t('otp.resend')}
          </button>
        </div>
      }
    />
  );
}
