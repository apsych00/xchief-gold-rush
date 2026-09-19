import { useEffect, useId, useRef, useState } from 'react';
import { useLang } from './i18n.js';
import { isValidCode, isValidEmail } from './promptValidation.js';
import { OTP_CODE_LENGTH } from './config.js';

// The one shared email/OTP-code prompt shell (unify-email-modal ticket): every place the app
// asks a player for an email address or the code that follows renders this same modal -
// same spacing, same reserved error region, same button treatment. Identity.jsx's OtpModal walks
// a player through two of these in a row (email, then code) without ever unmounting the
// backdrop; LeadCapture.jsx and SignupForm.jsx each render exactly one, for their own single
// email field. The component owns only its own field/error/busy state - never a verdict; a
// rejected onSubmit is shown as-is via `mapError`, the same rule useGame.js's OTP actions follow
// (the server decides, this just displays what it said).

const FOCUSABLE = 'button, input, a[href], [tabindex]:not([tabindex="-1"])';

export default function PromptModal({
  title,
  subtitle,
  fieldType = 'email', // 'email' | 'code'
  codeLength = OTP_CODE_LENGTH,
  initialValue = '',
  placeholder,
  ariaLabel,
  submitLabel,
  busyLabel,
  cancelLabel,
  onSubmit, // (value) => Promise | any. A rejection's error is mapped and shown, never thrown further.
  onCancel, // omit to hide the cancel button entirely
  validate, // optional (value) => errorString|'' override of the built-in email/code check
  mapError, // optional (err) => errorString override of the default message
  footer, // optional ReactNode rendered between the error region and the action row
  resetKey, // change this to reset the field/error/focus for a new step (e.g. email -> code)
  modalClassName = '',
  dialogLabel,
}) {
  const { t } = useLang();
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const dialogRef = useRef(null);
  const errorId = useId();

  // Reset on open and on every step change (resetKey), and move focus into the field - the same
  // moment a step's own copy/placeholder changes, so "email -> code" reads as one dialog moving
  // forward, not two modals swapping places.
  useEffect(() => {
    setValue(initialValue);
    setError('');
    setBusy(false);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // Escape closes (when a cancel handler exists); Tab/Shift+Tab stays trapped inside the dialog.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (!onCancel) return;
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      const node = dialogRef.current;
      if (!node) return;
      const focusable = Array.from(node.querySelectorAll(FOCUSABLE)).filter((el) => !el.disabled);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const defaultValidate = (raw) => {
    if (fieldType === 'code') {
      return isValidCode(raw, codeLength) ? '' : t('prompt.errors.invalidCode', { n: codeLength });
    }
    return isValidEmail(raw) ? '' : t('prompt.errors.invalidEmail');
  };

  const submit = (e) => {
    e.preventDefault();
    if (busy) return;
    const raw = fieldType === 'email' ? value.trim().toLowerCase() : value;
    const clientError = (validate || defaultValidate)(raw);
    if (clientError) {
      setError(clientError);
      return;
    }
    setError('');
    setBusy(true);
    Promise.resolve()
      .then(() => onSubmit(raw))
      .catch((err) => {
        setError((mapError ? mapError(err) : err?.message) || t('prompt.errors.default'));
        if (fieldType === 'code') {
          setValue('');
          inputRef.current?.focus();
        }
      })
      .finally(() => setBusy(false));
  };

  const onChange = (e) => {
    const next = fieldType === 'code' ? e.target.value.replace(/\D/g, '').slice(0, codeLength) : e.target.value;
    setValue(next);
    // Never blocks typing; clears a shown error the moment the player starts correcting it.
    if (error) setError('');
  };

  const inputProps =
    fieldType === 'code'
      ? {
          type: 'text',
          inputMode: 'numeric',
          pattern: '[0-9]*',
          autoComplete: 'one-time-code',
          maxLength: codeLength,
        }
      : {
          type: 'email',
          inputMode: 'email',
          autoComplete: 'email',
          autoCapitalize: 'off',
          autoCorrect: 'off',
          spellCheck: false,
        };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={dialogLabel || title}>
      <div className={`modal prompt-modal ${modalClassName}`.trim()} ref={dialogRef}>
        <form onSubmit={submit} noValidate>
          <div className="modal-title">{title}</div>
          {subtitle && <div className="modal-sub">{subtitle}</div>}
          <input
            ref={inputRef}
            className={`${fieldType === 'code' ? 'pin-input' : 'lead-input'} prompt-input ${
              fieldType === 'code' ? 'prompt-input-code' : ''
            }`.trim()}
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            aria-label={ariaLabel || placeholder}
            aria-invalid={!!error}
            aria-describedby={errorId}
            dir="ltr"
            {...inputProps}
          />
          {/* prompt-error carries the reserved-space rules; lead-error is kept alongside it only
              so the error text still matches the pre-existing .modal .lead-error selector every
              other server-error-mapping e2e spec in this suite already uses (InstagramModal's own
              error line, the OTP suites written before this ticket) - one error region, two
              class hooks, never two implementations. */}
          <div id={errorId} className="prompt-error lead-error" aria-live="polite">
            {error}
          </div>
          {footer}
          <div className="modal-actions">
            {onCancel && (
              <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
                {cancelLabel || t('prompt.cancel')}
              </button>
            )}
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? busyLabel || t('prompt.working') : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
