import { useEffect, useRef, useState } from 'react';
import { PROMO_VIDEO_SECONDS, PROMO_VIDEO_URL, STAFF_PIN, TASK_ICONS, VERIFY_MODE } from './config.js';
import { num, useLang } from './i18n.js';
import { apiUrl } from './api/client.js';
import { getStoredToken } from './api/socket.js';
import Logo from './Logo.jsx';

function PinModal({ onOk, onCancel }) {
  const { t } = useLang();
  const [pin, setPin] = useState('');
  const [wrong, setWrong] = useState(false);
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);
  const submit = (e) => {
    e.preventDefault();
    if (pin === STAFF_PIN) onOk();
    else {
      setWrong(true);
      setPin('');
      ref.current?.focus();
    }
  };
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <form className="modal" onSubmit={submit}>
        <div className="modal-title">{t('tasks.pinTitle')}</div>
        <div className="modal-sub">
          {wrong ? <span className="lead-error">{t('tasks.pinWrong')}</span> : t('tasks.pinSub')}
        </div>
        <input
          ref={ref}
          className="pin-input"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          aria-label={t('tasks.pinSub')}
        />
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            {t('tasks.cancel')}
          </button>
          <button type="submit" className="btn-primary" disabled={pin.length < 4}>
            {t('tasks.pinOk')}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * The video reward (ticket B6): reports {seconds, duration} to the server at most every 5 s
 * while it plays and once on ended (or, with no PROMO_VIDEO_URL configured, from the same
 * fallback countdown this modal always had) - the server decides when 90% has been crossed and
 * releases the reward itself; this component never grants anything on its own.
 */
function VideoModal({ onProgress, onDone, onCancel }) {
  const { t } = useLang();
  const [left, setLeft] = useState(PROMO_VIDEO_SECONDS);
  const lastSentAt = useRef(0);

  const report = (seconds, duration, force) => {
    const now = Date.now();
    if (!force && now - lastSentAt.current < 5000) return;
    lastSentAt.current = now;
    onProgress(Math.round(seconds), Math.round(duration));
  };

  useEffect(() => {
    if (PROMO_VIDEO_URL) return undefined;
    const id = setInterval(() => setLeft((s) => s - 1), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (PROMO_VIDEO_URL) return;
    if (left <= 0) {
      report(PROMO_VIDEO_SECONDS, PROMO_VIDEO_SECONDS, true);
      onDone();
    } else {
      report(PROMO_VIDEO_SECONDS - left, PROMO_VIDEO_SECONDS, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, onDone]);

  const pct = PROMO_VIDEO_URL ? 0 : ((PROMO_VIDEO_SECONDS - left) / PROMO_VIDEO_SECONDS) * 100;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-video">
        {PROMO_VIDEO_URL ? (
          <video
            className="promo-video"
            src={PROMO_VIDEO_URL}
            autoPlay
            playsInline
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              if (v.duration) report(v.currentTime, v.duration, false);
            }}
            onEnded={(e) => {
              const v = e.currentTarget;
              const duration = v.duration || v.currentTime;
              report(duration, duration, true);
              onDone();
            }}
          />
        ) : (
          <div className="promo-fallback">
            <Logo height={44} />
            <div className="promo-tagline">{t('tasks.videoTitle')}</div>
            <div className="promo-sub">{t('tasks.videoSub')}</div>
            <div className="promo-bar">
              <div className="promo-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="promo-count" dir="ltr">
              {left}s
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            {t('tasks.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The rewards screen (docs/layers.md C5; ticket B6+B7+B9). Renders entirely from tasksRows -
 * public.get_tasks()'s own id/title/reward/claimed/kind/url - never a client-side task table:
 * decision 1 removed src/config.js's old TASKS constant along with the last client-computed
 * reward numbers. What "start" does depends only on `kind`:
 *   - 'video': opens the video modal above; progress reports go to the server as they happen.
 *   - 'redirect': opens the destination after telling the server the visit started, then reports
 *     the return when this tab regains focus.
 *   - 'email' / 'signup': both are released by verify_otp_code once an email is verified
 *     (decision 4), not by anything claimed here - "start" opens the OTP screen instead.
 *   - 'instagram': B8's own ticket, not built yet - shown with no action.
 *   - 'manual' (kept for future use; none seeded): the old instant-claim / PIN-gated path.
 */
export default function Tasks({
  tasksRows = [],
  onClaim,
  onRefreshTasks,
  onReportVideoProgress,
  onStartTaskVisit,
  onReturnTaskVisit,
  onOpenIdentity,
  onToast,
}) {
  const { t, lang } = useLang();
  const [now, setNow] = useState(Date.now());
  const [waiting, setWaiting] = useState({}); // task id -> window-close timestamp
  const [pinFor, setPinFor] = useState(null);
  const [videoTask, setVideoTask] = useState(null);
  const [igStatus, setIgStatus] = useState(() => new URLSearchParams(window.location.search).get('ig'));
  const pendingReturns = useRef(new Set());

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ig = params.get('ig');
    if (ig) {
      setIgStatus(ig);
      params.delete('ig');
      const qs = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
      // A successful return should refresh the task list so the instagram row shows claimed.
      if (ig === 'done') onRefreshTasks?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  // A repeatable task's `claimed` flips back to false server-side once its cooldown passes
  // (public.get_tasks(), docs/layers.md C5); refetch periodically while this screen is open so
  // that happens without the player having to leave and come back.
  useEffect(() => {
    if (!onRefreshTasks) return undefined;
    const id = setInterval(onRefreshTasks, 5000);
    return () => clearInterval(id);
  }, [onRefreshTasks]);

  // Redirect and return (ticket B7 decision 3): once a visit is open, the tab regaining focus is
  // the "return" signal. Lenient by design - a wrong-early return just gets `not_yet` back and
  // stays pending for the next focus, since the client has no better way to know the server's
  // exact clock than to ask again.
  useEffect(() => {
    const onFocus = () => {
      for (const taskId of pendingReturns.current) {
        onReturnTaskVisit(taskId)
          .then(() => {
            pendingReturns.current.delete(taskId);
            setWaiting((w) => {
              const n = { ...w };
              delete n[taskId];
              return n;
            });
          })
          .catch((err) => {
            if (err?.code === 'not_yet') return; // still inside the window: try again next focus
            pendingReturns.current.delete(taskId);
            setWaiting((w) => {
              const n = { ...w };
              delete n[taskId];
              return n;
            });
            onToast?.(err?.code || 'error');
          });
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [onReturnTaskVisit, onToast]);

  const statusOf = (row) => {
    if (row.claimed) return { kind: 'claimed' };
    const until = waiting[row.id];
    if (until) return { kind: 'waiting', left: Math.max(0, until - now) };
    return { kind: 'available' };
  };

  const beginRedirect = (row) => {
    onStartTaskVisit(row.id)
      .then((res) => {
        pendingReturns.current.add(row.id);
        setWaiting((w) => ({ ...w, [row.id]: Date.now() + (res?.window_ms ?? 5000) }));
        window.open(row.url, '_blank', 'noopener');
      })
      .catch((err) => onToast?.(err?.code || 'error'));
  };

  const begin = (row) => {
    if (row.kind === 'video') {
      setVideoTask(row);
      return;
    }
    if (row.kind === 'redirect') {
      beginRedirect(row);
      return;
    }
    if (row.kind === 'email' || row.kind === 'signup') {
      onOpenIdentity?.();
      return;
    }
    if (row.kind === 'instagram') {
      const token = getStoredToken();
      if (!token) {
        onToast?.('unauthenticated');
        return;
      }
      setIgStatus('connecting');
      window.location.href = apiUrl(`/api/instagram/start?token=${encodeURIComponent(token)}`);
      return;
    }
    // 'manual' (none seeded, kept for future use): the same instant-claim / PIN-gated path this
    // screen always had for a task with no server-tracked progress of its own.
    if (VERIFY_MODE === 'pin') {
      setPinFor(row.id);
      return;
    }
    onClaim(row.id);
  };

  const instagramBannerText =
    igStatus === 'done'
      ? t('tasks.instagramDone')
      : igStatus === 'not_configured'
        ? t('tasks.instagramComingSoon')
        : igStatus === 'connecting'
          ? t('tasks.instagramPending')
          : igStatus
            ? t('tasks.instagramFailed')
            : null;

  return (
    <section className="tasks">
      <div className="screen-head">
        <div className="screen-title">{t('tasks.title')}</div>
        <div className="screen-sub">{t('tasks.sub')}</div>
      </div>
      {instagramBannerText && (
        <div
          className={`instagram-status ${igStatus === 'done' ? 'instagram-status-done' : igStatus === 'not_configured' ? 'instagram-status-soon' : 'instagram-status-pending'}`}
          role="status"
        >
          {instagramBannerText}
        </div>
      )}
      <div className="task-list">
        {tasksRows.map((row) => {
          const st = statusOf(row);
          const item = `tasks.items.${row.id}`;
          const done = st.kind === 'claimed';
          const notConfigured = row.kind === 'instagram' && igStatus === 'not_configured';
          return (
            <div
              key={row.id}
              className={`task ${row.id === 'signup' ? 'task-featured' : ''} ${done ? 'task-done' : ''}`}
            >
              <div className="task-icon" aria-hidden="true">
                {TASK_ICONS[row.id] || '•'}
              </div>
              <div className="task-body">
                <div className="task-title">{t(`${item}.title`)}</div>
                <div className="task-desc">{t(`${item}.desc`)}</div>
              </div>
              <div className="task-side">
                <div className="task-reward" dir="ltr">
                  {t('tasks.reward', { n: num(row.reward, lang) })}
                </div>
                {st.kind === 'claimed' && <div className="task-state">{t('tasks.claimed')}</div>}
                {st.kind === 'waiting' && (
                  <button type="button" className="task-btn" disabled>
                    {t('tasks.waiting', { s: num(Math.ceil(st.left / 1000), lang) })}
                  </button>
                )}
                {st.kind === 'available' && !notConfigured && (
                  <button type="button" className="task-btn" onClick={() => begin(row)}>
                    {row.kind === 'redirect' ? t('tasks.open') : t('tasks.start')}
                  </button>
                )}
                {notConfigured && (
                  <button type="button" className="task-btn" disabled>
                    {t('tasks.instagramComingSoon')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {pinFor && (
        <PinModal
          onOk={() => {
            onClaim(pinFor);
            setPinFor(null);
          }}
          onCancel={() => setPinFor(null)}
        />
      )}
      {videoTask && (
        <VideoModal
          onProgress={(seconds, duration) => onReportVideoProgress(videoTask.id, seconds, duration)}
          onDone={() => setVideoTask(null)}
          onCancel={() => setVideoTask(null)}
        />
      )}
    </section>
  );
}
