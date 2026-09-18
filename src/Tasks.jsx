import { useCallback, useEffect, useRef, useState } from 'react';
import { PROMO_VIDEO_SECONDS, PROMO_VIDEO_URL, STAFF_PIN, TASK_ICONS, VERIFY_MODE } from './config.js';
import { accumulateWatchTime } from './watchTime.js';
import { num, useLang } from './i18n.js';
import { apiUrl } from './api/client.js';
import { getStoredToken } from './api/socket.js';
import { clearSignupTimer, readSignupTimer, writeSignupTimer } from './signupTimer.js';
import Logo from './Logo.jsx';

/**
 * Format milliseconds as mm:ss or h:mm:ss for the signup mission countdown.
 * Seconds are rounded up so the display never jumps from 1:00:01 to 0:59:59 in one tick.
 */
function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

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
 * Load the YouTube IFrame Player API once per page lifetime. The script is added only when a
 * YouTube mission is opened, and only on the web build (kiosk never reaches this screen).
 */
let youtubeApiPromise = null;
function loadYouTubeApi() {
  if (typeof document === 'undefined') return Promise.reject(new Error('no document'));
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (!youtubeApiPromise) {
    youtubeApiPromise = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.onerror = () => reject(new Error('youtube_api_load_failed'));
      document.body.appendChild(tag);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (prev) prev();
        resolve(window.YT);
      };
      setTimeout(() => reject(new Error('youtube_api_timeout')), 15000);
    });
  }
  return youtubeApiPromise;
}

/**
 * Accumulated watched time for the YouTube player. Reads getCurrentTime() once per second while
 * the video is playing and adds the delta to the running total, capping each tick at 1.5 s so a
 * programmatic seek cannot credit skipped time. Reports {seconds, duration} at most every 5 s and
 * once on ENDED.
 */
function useYouTubeWatch({ getCurrentTime, playerState, duration, onProgress, onDone }) {
  const watched = useRef(0);
  const lastCurrent = useRef(0);
  const lastReportAt = useRef(0);
  const reportedDone = useRef(false);

  const report = useCallback(
    (force) => {
      const now = Date.now();
      if (!force && now - lastReportAt.current < 5000) return;
      lastReportAt.current = now;
      onProgress(Math.round(watched.current), Math.round(duration || 0));
    },
    [onProgress, duration],
  );

  useEffect(() => {
    const id = setInterval(() => {
      if (playerState !== window.YT?.PlayerState?.PLAYING) return;
      const current = getCurrentTime() || 0;
      watched.current = accumulateWatchTime({
        current,
        previous: lastCurrent.current,
        accumulated: watched.current,
      });
      lastCurrent.current = current;
      report(false);
    }, 1000);
    return () => clearInterval(id);
  }, [playerState, getCurrentTime, report]);

  useEffect(() => {
    if (playerState === window.YT?.PlayerState?.ENDED && !reportedDone.current) {
      reportedDone.current = true;
      report(true);
      onDone();
    }
  }, [playerState, onDone, report]);

  // Reset when the hook is re-created (task changes).
  useEffect(() => {
    watched.current = 0;
    lastCurrent.current = 0;
    lastReportAt.current = 0;
    reportedDone.current = false;
  }, []);
}

/**
 * The video reward modal (ticket B6 / K4). Supports three modes:
 *   - YouTube mission: the task row carries kind='youtube' and url=videoId; the IFrame Player API
 *     is loaded and an accumulated-watch timer reports progress.
 *   - Promo video: a hosted <video> asset reports currentTime directly.
 *   - Fallback countdown: used when no video asset is configured.
 *
 * The server decides when the reward releases; this component never grants anything on its own.
 */
function VideoModal({ task, onProgress, onDone, onCancel }) {
  const { t } = useLang();
  const [left, setLeft] = useState(PROMO_VIDEO_SECONDS);
  const lastSentAt = useRef(0);
  const containerRef = useRef(null);
  const [player, setPlayer] = useState(null);
  const [playerState, setPlayerState] = useState(-1);
  const [playerError, setPlayerError] = useState(null);

  const isYouTube = task?.kind === 'youtube';
  const isHostedVideo = !isYouTube && PROMO_VIDEO_URL;

  const report = (seconds, duration, force) => {
    const now = Date.now();
    if (!force && now - lastSentAt.current < 5000) return;
    lastSentAt.current = now;
    onProgress(Math.round(seconds), Math.round(duration));
  };

  // Hosted <video> / fallback countdown paths (unchanged from B6).
  useEffect(() => {
    if (isYouTube || isHostedVideo) return undefined;
    const id = setInterval(() => setLeft((s) => s - 1), 1000);
    return () => clearInterval(id);
  }, [isYouTube, isHostedVideo]);

  useEffect(() => {
    if (isYouTube || isHostedVideo) return undefined;
    if (left <= 0) {
      report(PROMO_VIDEO_SECONDS, PROMO_VIDEO_SECONDS, true);
      onDone();
    } else {
      report(PROMO_VIDEO_SECONDS - left, PROMO_VIDEO_SECONDS, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, onDone, isYouTube, isHostedVideo]);

  // YouTube IFrame Player setup.
  useEffect(() => {
    if (!isYouTube) return undefined;
    let destroyed = false;
    let ytPlayer = null;
    loadYouTubeApi()
      .then((YT) => {
        if (destroyed || !containerRef.current) return;
        ytPlayer = new YT.Player(containerRef.current, {
          videoId: task.url,
          playerVars: {
            controls: 0,
            disablekb: 1,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
          },
          events: {
            onReady: () => {
              if (!destroyed) {
                ytPlayer.playVideo();
                setPlayer(ytPlayer);
              }
            },
            onStateChange: (e) => {
              if (!destroyed) setPlayerState(e.data);
            },
            onError: (e) => {
              if (!destroyed) setPlayerError(String(e.data));
            },
          },
        });
      })
      .catch((err) => setPlayerError(err?.message || 'youtube_load_failed'));
    return () => {
      destroyed = true;
      try {
        ytPlayer?.destroy?.();
      } catch {
        /* ignore */
      }
    };
  }, [isYouTube, task.url]);

  useYouTubeWatch({
    getCurrentTime: () => player?.getCurrentTime?.() || 0,
    playerState,
    duration: player?.getDuration?.() || 0,
    onProgress,
    onDone,
  });

  const pct = isHostedVideo
    ? 0
    : ((PROMO_VIDEO_SECONDS - left) / PROMO_VIDEO_SECONDS) * 100;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-video">
        {isYouTube ? (
          <div className="youtube-player-wrap">
            <div ref={containerRef} className="youtube-player" />
            {playerError && <div className="lead-error">{t('tasks.videoSub')}</div>}
          </div>
        ) : isHostedVideo ? (
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
 * The rewards screen (docs/layers.md C5; ticket B6+B7+B9 / K4). Renders entirely from tasksRows -
 * public.get_tasks()'s own id/title/reward/claimed/kind/url - never a client-side task table.
 * What "start" does depends only on `kind`:
 *   - 'video' / 'youtube': opens the video modal; progress reports go to the server as they happen.
 *   - 'redirect': opens the destination after telling the server the visit started, then reports
 *     the return when the window ends (a timer, not only a focus event). The signup mission is a
 *     redirect task with a persisted 1-hour window and its own external registration URL.
 *   - 'email': released by verify_otp_code once an email is verified; "start" opens the OTP screen.
 *   - 'instagram': B8's own ticket - shown with no action.
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
  const returnTimers = useRef(new Map());

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

  const finishReturn = (taskId) => {
    pendingReturns.current.delete(taskId);
    returnTimers.current.delete(taskId);
    setWaiting((w) => {
      const n = { ...w };
      delete n[taskId];
      return n;
    });
  };

  const tryReturn = useCallback(
    (taskId) => {
      onReturnTaskVisit(taskId)
        .then(() => finishReturn(taskId))
        .catch((err) => {
          if (err?.code === 'not_yet' && typeof err?.retry_ms === 'number') {
            const timer = setTimeout(() => tryReturn(taskId), err.retry_ms);
            returnTimers.current.set(taskId, timer);
            return;
          }
          finishReturn(taskId);
          onToast?.(err?.code || 'error');
        });
    },
    [onReturnTaskVisit, onToast],
  );

  // A ref lets the mount-time restore effect call the current tryReturn without re-running
  // whenever the callback identity changes.
  const tryReturnRef = useRef(tryReturn);
  useEffect(() => {
    tryReturnRef.current = tryReturn;
  }, [tryReturn]);

  // Signup mission (ticket B9 -> redirect-with-timer): restore a persisted 1-hour countdown
  // from a previous session. If the deadline has already passed, try to release immediately;
  // otherwise show the remaining time and schedule the release.
  useEffect(() => {
    const until = readSignupTimer();
    if (!until) return;
    pendingReturns.current.add('signup');
    setWaiting((w) => ({ ...w, signup: until }));
    const remaining = until - Date.now();
    if (remaining <= 0) {
      tryReturnRef.current('signup');
      return;
    }
    const timer = setTimeout(() => {
      returnTimers.current.delete('signup');
      if (pendingReturns.current.has('signup')) tryReturnRef.current('signup');
    }, remaining);
    returnTimers.current.set('signup', timer);
  }, []);

  // Once the server marks the signup task claimed, drop the persisted timer and any pending
  // return state so the row shows Claimed instead of a stuck countdown.
  useEffect(() => {
    const signupRow = tasksRows.find((r) => r.id === 'signup');
    if (signupRow?.claimed) {
      clearSignupTimer();
      finishReturn('signup');
    }
  }, [tasksRows]);

  // Redirect and return (ticket B7 / K4): once a visit is open, the tab regaining focus is one
  // return signal, but the primary signal is the 5 s window ending. A wrong-early return gets
  // `not_yet` back and is retried after retry_ms.
  useEffect(() => {
    const onFocus = () => {
      for (const taskId of pendingReturns.current) {
        // Avoid duplicate in-flight returns.
        if (returnTimers.current.has(taskId)) continue;
        tryReturn(taskId);
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [tryReturn]);

  useEffect(() => {
    const timers = returnTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const statusOf = (row) => {
    if (row.claimed) return { kind: 'claimed' };
    const until = waiting[row.id];
    if (until) return { kind: 'waiting', left: Math.max(0, until - now) };
    return { kind: 'available' };
  };

  const beginRedirect = (row) => {
    onStartTaskVisit(row.id)
      .then((res) => {
        // The signup mission uses the same redirect-and-return path as other external links, but
        // its window is 1 hour and is persisted across reloads so the player can close the app
        // and come back to a correct remaining countdown.
        const isSignup = row.id === 'signup';
        const windowMs = isSignup ? 60 * 60 * 1000 : (res?.window_ms ?? 5000);
        const until = Date.now() + windowMs;
        if (isSignup) writeSignupTimer(until);
        pendingReturns.current.add(row.id);
        setWaiting((w) => ({ ...w, [row.id]: until }));
        window.open(row.url, '_blank', 'noopener');
        // K4: when the window ends, send task_return immediately without waiting for focus.
        const timer = setTimeout(() => {
          returnTimers.current.delete(row.id);
          if (pendingReturns.current.has(row.id)) tryReturn(row.id);
        }, windowMs);
        returnTimers.current.set(row.id, timer);
      })
      .catch((err) => onToast?.(err?.code || 'error'));
  };

  const begin = (row) => {
    if (row.kind === 'video' || row.kind === 'youtube') {
      setVideoTask(row);
      return;
    }
    if (row.kind === 'redirect') {
      beginRedirect(row);
      return;
    }
    if (row.kind === 'email') {
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
                {TASK_ICONS[row.id] || TASK_ICONS[row.kind] || '•'}
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
                    {row.id === 'signup'
                      ? t('tasks.signupWaiting', { t: formatCountdown(st.left) })
                      : t('tasks.waiting', { s: num(Math.ceil(st.left / 1000), lang) })}
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
          task={videoTask}
          onProgress={(seconds, duration) => onReportVideoProgress(videoTask.id, seconds, duration)}
          onDone={() => setVideoTask(null)}
          onCancel={() => setVideoTask(null)}
        />
      )}
    </section>
  );
}
