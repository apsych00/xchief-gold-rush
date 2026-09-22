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

/** The build id baked into this bundle, or 'dev' when running from the Vite dev server. */
export const RUNNING_BUILD = RUNNING;

/**
 * Polls the deployed build id and returns it (null until the first answer lands). The web app
 * turns a difference into a banner to tap; the kiosk (useKioskAutoReload) acts on it without
 * asking, because nobody is standing there to tap anything. The kiosk needs the id itself, not
 * just "stale", so it can avoid chasing the same build twice - see kioskAutoReload.js.
 */
export function useDeployedBuildId() {
  const [deployed, setDeployed] = useState(null);

  useEffect(() => {
    if (RUNNING === 'dev') return undefined;
    let cancelled = false;
    const check = async () => {
      try {
        const id = await fetchDeployedId();
        if (!cancelled && id) setDeployed(id);
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

  return deployed;
}

/** True once the deployed build id differs from the one baked into this bundle. */
export function useBuildIsStale() {
  const deployed = useDeployedBuildId();
  return Boolean(deployed && deployed !== RUNNING);
}

export default function UpdateBanner() {
  const { t } = useLang();
  const stale = useBuildIsStale();

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
