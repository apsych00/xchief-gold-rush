import { useEffect, useMemo, useState } from 'react';
import { LANG_KEY, LangContext, makeT, readStoredLang, useLang } from './i18n.js';
import Logo from './Logo.jsx';
import { getShareStatus } from './api/share.js';

function setMeta(name, content) {
  if (typeof document === 'undefined') return;
  let el = document.querySelector(`meta[property="${name}"],meta[name="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(name.startsWith('og:') ? 'property' : 'name', name);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function setTitle(title) {
  if (typeof document !== 'undefined') document.title = title;
}

function BannerCard({ data }) {
  const { t } = useLang();
  if (!data) {
    return (
      <div className="share-card share-card-empty">
        <div className="share-card-title">{t('share.cardTitle')}</div>
        <div className="share-card-record">—</div>
        <div className="share-card-note">{t('share.notAvailable')}</div>
      </div>
    );
  }
  return (
    <div className="share-card">
      <div className="share-card-mark" aria-hidden="true">
        <span className="logo" dir="ltr">
          <Logo height={26} />
        </span>
      </div>
      <div className="share-card-title">{t('share.cardTitle')}</div>
      <div className="share-card-record" dir="ltr">
        {data.record?.toLocaleString?.('en-US') ?? data.record}
      </div>
      <div className="share-card-unit">{t('profile.coins')}</div>
      {data.rank && (
        <div className="share-card-rank">
          {t('share.rank', { rank: data.rank.toLocaleString?.('en-US') ?? data.rank, tier: data.tier || '' })}
        </div>
      )}
    </div>
  );
}

function ShareBody({ token, onData }) {
  const { t } = useLang();
  const [data, setData] = useState(undefined);

  useEffect(() => {
    let cancelled = false;
    getShareStatus(token)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          onData?.(d);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setData(null);
          onData?.(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, onData, t]);

  const tournamentLabel = data?.tournament_title
    ? t('share.joinTournament', { title: data.tournament_title })
    : t('share.play');

  return (
    <section className="home claim-home share-page">
      <div className="screen-head">
        <div className="screen-title">{t('share.title')}</div>
      </div>
      <BannerCard data={data} />
      <div className="share-actions">
        <a href="/" className="btn-primary share-cta">
          {t('share.play')}
        </a>
        {data !== null && (
          <a href="/" className="btn-ghost share-cta">
            {tournamentLabel}
          </a>
        )}
      </div>
    </section>
  );
}

export default function SharePage({ token }) {
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

  const baseUrl = typeof window !== 'undefined' ? `${window.location.origin}` : '';
  const ogImage = `${baseUrl}/share/og.png`;

  const handleData = (data) => {
    const t = langCtx.t;
    const title = data
      ? t('share.ogTitle', { display: data.display, record: data.record })
      : t('share.ogTitleDefault');
    const description = data
      ? t('share.ogDescription', { display: data.display, record: data.record })
      : t('share.ogDescriptionDefault');
    setTitle(title);
    setMeta('og:title', title);
    setMeta('og:description', description);
    setMeta('og:image', ogImage);
    setMeta('og:type', 'website');
    setMeta('twitter:card', 'summary_large_image');
  };

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
          <ShareBody token={token} onData={handleData} />
        </div>
      </div>
    </LangContext.Provider>
  );
}
