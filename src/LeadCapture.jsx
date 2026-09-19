import { useState } from 'react';
import { useLang } from './i18n.js';
import { readLead, submitLead } from './leads.js';
import PromptModal from './PromptModal.jsx';

export { readLead, submitLead } from './leads.js';

/**
 * One-field email capture, marketing lead only (no OTP, no server verification - just the
 * address, kept locally and shipped to /api/lead). A small card with a title, a subtitle and one
 * button; tapping the button opens the one shared email/OTP prompt (PromptModal, unify-email-
 * modal ticket) instead of an inline input, so every "type your email" moment in the app - this
 * one, the xChief signup, and the real OTP flow - is the same dialog.
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
  const [open, setOpen] = useState(false);

  if (done) {
    return (
      <div className={`lead lead-${variant} lead-done`} role="status">
        {t('lead.done')}
      </div>
    );
  }

  const submitEmail = (email) => {
    submitLead({ email, source, balance, lang, page: window.location.pathname });
    setDone(true);
    setOpen(false);
    onDone?.();
  };

  return (
    <>
      <section className={`lead lead-${variant}`} aria-labelledby={`lead-title-${source}`}>
        <div id={`lead-title-${source}`} className="lead-title">
          {title || t('lead.title')}
        </div>
        <div className="lead-sub">{subtitle || t('lead.sub')}</div>
        <button type="button" className="lead-btn lead-btn-block" onClick={() => setOpen(true)}>
          {t('lead.cta')}
        </button>
        <div className="lead-foot">
          <span>{t('lead.privacy')}</span>
          {onDismiss && (
            <button type="button" className="lead-skip" onClick={onDismiss}>
              {dismissLabel || t('lead.skip')}
            </button>
          )}
        </div>
      </section>
      {open && (
        <PromptModal
          resetKey={source}
          title={title || t('lead.title')}
          subtitle={subtitle || t('lead.sub')}
          fieldType="email"
          placeholder={t('lead.placeholder')}
          submitLabel={t('lead.cta')}
          onSubmit={submitEmail}
          onCancel={() => setOpen(false)}
          dialogLabel={title || t('lead.title')}
        />
      )}
    </>
  );
}
