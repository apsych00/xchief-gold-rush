import { useEffect, useState } from 'react';
import { num, useLang } from './i18n.js';
import PromptModal from './PromptModal.jsx';
import { OTP_CODE_LENGTH } from './config.js';

const RESEND_COOLDOWN_MS = 30000;

// The server error -> copy mapping for both OTP steps (unify-email-modal ticket: this is the one
// place that maps an OTP error code to a sentence; PromptModal never duplicates it - every call
// site that can get an OTP-shaped error back passes it through here via PromptModal's mapError).
export function errorText(t, code) {
  const key = `otp.errors.${code || 'default'}`;
  const msg = t(key);
  return msg === key ? t('otp.errors.default') : msg;
}

/* The header used to carry a web identity line here (docs/layers.md C3): the masked email plus a
 * Sign out text link, on its own row above every screen. It is gone - a whole row of vertical
 * space on every screen, spent on an action almost nobody takes and a fact the profile screen
 * already states. Both moved to Profile, where the sign-out is now a real button behind a
 * confirmation (src/Profile.jsx). */

/**
 * The OTP entry screen (docs/layers.md C3): email -> code -> done. Both steps render
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
        subtitle={t('otp.emailSub', { n: OTP_CODE_LENGTH })}
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
      subtitle={t('otp.codeSub', { email, n: OTP_CODE_LENGTH })}
      fieldType="code"
      codeLength={OTP_CODE_LENGTH}
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
