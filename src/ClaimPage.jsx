/**
 * The /claim/<token> page (ticket C9, docs/tickets/c9-qr-claim.md decision 4): a web-mode
 * screen with no game UI at all, rendered by main.jsx in place of the whole game app whenever
 * location.pathname starts with /claim/ - no router library, the same "separate tree" split
 * KioskApp.jsx uses for the booth. It never opens the game socket (src/api/socket.js): the two
 * HTTP calls in src/api/claim.js are all it needs.
 */
import { useEffect, useMemo, useState } from 'react';
import { LANG_KEY, LangContext, makeT, readStoredLang, useLang } from './i18n.js';
import Logo from './Logo.jsx';
import { getClaimStatus, submitClaim } from './api/claim.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function ClaimForm({ token, onClaimed }) {
  const { t } = useLang();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = (e) => {
    e.preventDefault();
    const em = email.trim().toLowerCase();
    if (!EMAIL_RE.test(em)) {
      setError(t('claim.errInvalidEmail'));
      return;
    }
    setBusy(true);
    setError('');
    submitClaim(token, em)
      .then((res) => onClaimed({ code: res.code, email: em }))
      .catch((err) => setError(err?.code === 'invalid_email' ? t('claim.errInvalidEmail') : t('claim.errDefault')))
      .finally(() => setBusy(false));
  };

  return (
    <form onSubmit={submit} noValidate>
      <ol className="claim-steps">
        <li>{t('claim.step1')}</li>
        <li>{t('claim.step2')}</li>
        <li>{t('claim.step3')}</li>
      </ol>
      {error && <div className="lead-error">{error}</div>}
      <div className="claim-form">
        <input
          className="lead-input"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={t('claim.emailPlaceholder')}
          aria-label={t('claim.emailPlaceholder')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          dir="ltr"
          required
        />
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('claim.cta')}
        </button>
      </div>
    </form>
  );
}

function GiftCard({ code, email }) {
  const { t } = useLang();
  return (
    <div className="claim-card">
      <div className="kiosk-code" dir="ltr">
        {code}
      </div>
      <div className="modal-sub">{t('claim.sentTo', { email })}</div>
      <div className="modal-sub">{t('claim.cardNote')}</div>
    </div>
  );
}

function ClaimBody({ token }) {
  const { t } = useLang();
  const [status, setStatus] = useState(null); // null while loading
  const [claimed, setClaimed] = useState(null); // {code, email} once THIS visitor claims it

  useEffect(() => {
    let cancelled = false;
    getClaimStatus(token)
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatus({ state: 'invalid' });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (claimed) return <GiftCard code={claimed.code} email={claimed.email} />;
  if (status === null) return null;
  if (status.state === 'ready') return <ClaimForm token={token} onClaimed={setClaimed} />;
  if (status.state === 'claimed') return <div className="modal-sub">{t('claim.claimedBy', { email: status.email_masked })}</div>;
  if (status.state === 'expired') return <div className="modal-sub">{t('claim.expired')}</div>;
  return <div className="modal-sub">{t('claim.invalid')}</div>;
}

export default function ClaimPage({ token }) {
  const [lang, setLangState] = useState(readStoredLang);
  const langCtx = useMemo(() => {
    const setLang = (next) => {
      setLangState(next);
      try {
        localStorage.setItem(LANG_KEY, next);
      } catch {
        /* ignore */
      }
    };
    return { lang, t: makeT(lang), setLang };
  }, [lang]);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = 'ltr';
  }, [lang]);

  return (
    <LangContext.Provider value={langCtx}>
      <div className="app" dir="ltr" data-lang={lang}>
        <div className="phone">
          <header className="topbar">
            <div className="topbar-start">
              <div className="logo" dir="ltr">
                <Logo height={26} />
              </div>
            </div>
          </header>
          <section className="home claim-home">
            <div className="screen-head">
              <div className="screen-title">{langCtx.t('claim.title')}</div>
            </div>
            <ClaimBody token={token} />
          </section>
        </div>
      </div>
    </LangContext.Provider>
  );
}
