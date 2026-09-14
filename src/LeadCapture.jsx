import { useEffect, useRef, useState } from 'react';
import { useLang } from './i18n.js';
import { readLead, submitLead } from './leads.js';

export { readLead, submitLead } from './leads.js';

/**
 * One-field email capture. Uses a real <form> with the standard email
 * attributes so browsers and password managers autofill it in one tap.
 *
 * variant: 'card' (default) | 'slim' | 'inline' | 'result'
 * onDone / onDismiss: optional callbacks for the prompt flows.
 */
export default function LeadCapture({
  source,
  balance,
  variant = 'card',
  title,
  subtitle,
  onDone,
  onDismiss,
  dismissLabel,
}) {
  const { t, lang } = useLang();
  const [done, setDone] = useState(() => !!readLead());
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (!error) return undefined;
    const id = setTimeout(() => setError(''), 2500);
    return () => clearTimeout(id);
  }, [error]);

  if (done) {
    return (
      <div className={`lead lead-${variant} lead-done`} role="status">
        {t('lead.done')}
      </div>
    );
  }

  const onSubmit = (e) => {
    e.preventDefault();
    const input = inputRef.current;
    const email = (input?.value || '').trim();
    if (!input || !input.checkValidity() || !email.includes('@')) {
      setError(t('lead.invalid'));
      input?.focus();
      return;
    }
    submitLead({ email, source, balance, lang, page: window.location.pathname });
    setDone(true);
    onDone?.();
  };

  return (
    <section className={`lead lead-${variant}`} aria-labelledby={`lead-title-${source}`}>
      <div id={`lead-title-${source}`} className="lead-title">
        {title || t('lead.title')}
      </div>
      <div className="lead-sub">{subtitle || t('lead.sub')}</div>
      <form className="lead-form" onSubmit={onSubmit} noValidate autoComplete="on">
        <input
          ref={inputRef}
          className={error ? 'lead-input lead-input-error' : 'lead-input'}
          type="email"
          name="email"
          id={`lead-email-${source}`}
          autoComplete="email"
          inputMode="email"
          enterKeyHint="send"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          placeholder={t('lead.placeholder')}
          aria-label={t('lead.placeholder')}
          aria-invalid={!!error}
          dir="ltr"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button type="submit" className="lead-btn">
          {t('lead.cta')}
        </button>
      </form>
      <div className="lead-foot" aria-live="polite">
        {error ? <span className="lead-error">{error}</span> : t('lead.privacy')}
        {onDismiss && (
          <button type="button" className="lead-skip" onClick={onDismiss}>
            {dismissLabel || t('lead.skip')}
          </button>
        )}
      </div>
    </section>
  );
}
