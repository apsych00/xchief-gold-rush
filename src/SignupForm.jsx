import { useState } from 'react';
import { LINKS_PUBLIC } from './config.js';
import { useLang } from './i18n.js';
import { readLead, readSignup, registerUrl, submitSignup } from './leads.js';
import PromptModal from './PromptModal.jsx';

/**
 * In-game xChief signup: email only (ticket B4, docs/tasks-marketing-lead.md ground rules:
 * "Only the email identifies a web player"). Submitting stores the lead, pays the reward (via
 * onDone) and opens the real registration page with the email prefilled. We cannot verify the
 * external account, so the reward is tied to this form, which we can.
 *
 * The email step is the one shared PromptModal (unify-email-modal ticket) - no bespoke form of
 * its own any more. The done state has no input, so it keeps its own small result card in the
 * same modal-backdrop/modal shell (lifted straight from before).
 */
export default function SignupForm({ source, balance, reward, onDone, onCancel }) {
  const { t, lang } = useLang();
  const lead = readLead();
  const [done, setDone] = useState(() => !!readSignup());

  const submitEmail = (email) => {
    submitSignup({ email, source, balance, lang, page: window.location.pathname });
    setDone(true);
    onDone?.();
    // Open the real registration with the email prefilled. Done after the
    // state update so the reward shows even if the popup is blocked.
    window.open(registerUrl(LINKS_PUBLIC.demo, { email }), '_blank', 'noopener');
  };

  if (done) {
    return (
      <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('signup.doneTitle')}>
        <div className="modal signup">
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
        </div>
      </div>
    );
  }

  return (
    <PromptModal
      resetKey={source}
      title={t('signup.title')}
      subtitle={t('signup.sub', { n: reward })}
      fieldType="email"
      initialValue={lead?.email || ''}
      placeholder={t('signup.email')}
      submitLabel={t('signup.cta', { n: reward })}
      cancelLabel={onCancel ? t('signup.notNow') : undefined}
      onSubmit={submitEmail}
      onCancel={onCancel}
      footer={<div className="prompt-footnote">{t('signup.privacy')}</div>}
      modalClassName="signup"
      dialogLabel={t('signup.title')}
    />
  );
}
