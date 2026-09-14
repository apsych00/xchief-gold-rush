import { useEffect, useState } from 'react';
import { useLang } from './i18n.js';

/**
 * In-app browsers (Telegram, Instagram) cache the shell aggressively and
 * offer no reload button. This polls /version.json (never cached) and, when
 * the deployed build id differs from the running one, shows a one-tap
 * "Update" banner that hard-reloads with a cache-busting query.
 */
const CHECK_MS = 60 * 1000;
const RUNNING = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';

async function fetchDeployedId() {
  const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(String(r.status));
  const j = await r.json();
  return j && j.build ? String(j.build) : null;
}

export function reloadFresh() {
  const url = new URL(window.location.href);
  url.searchParams.set('v', String(Date.now()));
  window.location.replace(url.toString());
}

export default function UpdateBanner() {
  const { t } = useLang();
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (RUNNING === 'dev') return undefined;
    let cancelled = false;
    const check = async () => {
      try {
        const id = await fetchDeployedId();
        if (!cancelled && id && id !== RUNNING) setStale(true);
      } catch {
        /* offline or blocked: try again later */
      }
    };
    check();
    const timer = setInterval(check, CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (!stale) return null;
  return (
    <div className="update-banner" role="status">
      <span>{t('update.text')}</span>
      <button type="button" className="update-btn" onClick={reloadFresh}>
        {t('update.cta')}
      </button>
    </div>
  );
}
