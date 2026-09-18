import { useCallback, useEffect, useRef, useState } from 'react';
import { PROMO_VIDEO_SECONDS, PROMO_VIDEO_URL, STAFF_PIN, TASK_ICONS, VERIFY_MODE } from './config.js';
import { accumulateWatchTime } from './watchTime.js';
import { num, useLang } from './i18n.js';
import { clearSignupTimer, readSignupTimer, writeSignupTimer } from './signupTimer.js';
import { clearYoutubeCooldown, readYoutubeCooldown, writeYoutubeCooldown } from './youtubeMissionTimer.js';
import Logo from './Logo.jsx';

// The three seeded YouTube reward units (db/seed.sql), walked in id order and shown as one
// "Watch xChief videos" mission row. Each is released and ledgered on its own by the server; the
// row only advances the client's view. YT_COOLDOWN_MS is the pacing gap before the next video
// unlocks - purely a UI timer, since the reward itself is server-released from validated watch.
const YT_MISSION_IDS = ['youtube_1', 'youtube_2', 'youtube_3'];
const YT_COOLDOWN_MS = 3 * 60 * 1000;

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

  const pct = isHostedVideo ? 0 : ((PROMO_VIDEO_SECONDS - left) / PROMO_VIDEO_SECONDS) * 100;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-video">
        {isYouTube ? (
          <div className="youtube-player-wrap">
            <div ref={containerRef} className="youtube-player" />
            <button type="button" className="youtube-skip" onClick={onCancel}>
              {t('tasks.skip')}
            </button>
            <div className="youtube-watch-note">{t('tasks.videoWatchNote')}</div>
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
        {!isYouTube && (
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onCancel}>
              {t('tasks.cancel')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Instagram handle validation, mirrored from server/index.js normalizeHandle (ticket K3): trim,
// lowercase, drop a leading @, then 1-30 chars of Instagram's own [a-z0-9._] charset.
const IG_HANDLE_RE = /^[a-z0-9._]{1,30}$/;
function normalizeHandle(raw) {
  const handle = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '');
  return IG_HANDLE_RE.test(handle) ? handle : null;
}

/**
 * Open Instagram to our profile (ticket K3). The web profile URL works everywhere: it opens in
 * the browser on desktop and deep-links into the Instagram app on mobile (universal link). The
 * `instagram://` app scheme is deliberately not used - on desktop it throws "scheme does not have
 * a registered handler" in the console; the web URL avoids that and still opens the app on phones.
 */
function openInstagram(appUrl, profileUrl) {
  const url = profileUrl || appUrl;
  if (!url) return;
  window.open(url, '_blank', 'noopener');
}

/**
 * Instagram follow reward (ticket K3). Two steps in one modal:
 *   1. The player enters their handle. onStart stores it server-side and returns the follow URLs
 *      (or a not_configured signal). The client then opens Instagram - it never claims the follow.
 *   2. The player follows, comes back, and taps Check (or the tab regaining focus checks for
 *      them). onCheck asks the server to read BoxAPI and decide; the reward is released there.
 *
 * The server decides every outcome; this modal only reports what it observed and shows the copy.
 */
function InstagramModal({ onStart, onCheck, onNotConfigured, onDone, onCancel }) {
  const { t } = useLang();
  const [phase, setPhase] = useState('handle'); // 'handle' | 'follow'
  const [handle, setHandle] = useState('');
  const [error, setError] = useState(null); // i18n key for a refusal shown to the player
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const urlsRef = useRef({ appUrl: null, profileUrl: null });

  useEffect(() => {
    if (phase === 'handle') inputRef.current?.focus();
  }, [phase]);

  const reasonKey = (reason) => {
    switch (reason) {
      case 'not_following':
        return 'tasks.instagramNotFollowing';
      case 'private':
        return 'tasks.instagramPrivate';
      case 'not_found':
        return 'tasks.instagramNotFound';
      default:
        return 'tasks.instagramFailed';
    }
  };

  const errorKeyFor = (code) => {
    switch (code) {
      case 'invalid_handle':
        return 'tasks.instagramInvalidHandle';
      case 'instagram_handle_taken':
        return 'tasks.instagramHandleTaken';
      case 'instagram_already_verified':
        return 'tasks.instagramAlreadyVerified';
      case 'rate_limited':
        return 'tasks.instagramRateLimited';
      default:
        return 'tasks.instagramFailed';
    }
  };

  const submitHandle = (e) => {
    e.preventDefault();
    const clean = normalizeHandle(handle);
    if (!clean) {
      setError('tasks.instagramInvalidHandle');
      return;
    }
    setBusy(true);
    setError(null);
    onStart(clean)
      .then((res) => {
        setBusy(false);
        if (res?.status === 'not_configured') {
          onNotConfigured();
          onCancel();
          return;
        }
        urlsRef.current = { appUrl: res?.app_url || null, profileUrl: res?.profile_url || null };
        setPhase('follow');
        openInstagram(res?.app_url, res?.profile_url);
      })
      .catch((err) => {
        setBusy(false);
        setError(errorKeyFor(err?.code));
      });
  };

  const check = useCallback(() => {
    setBusy(true);
    setError(null);
    onCheck()
      .then((res) => {
        setBusy(false);
        if (res?.ok) {
          onDone();
          return;
        }
        setError(reasonKey(res?.reason));
      })
      .catch((err) => {
        setBusy(false);
        setError(errorKeyFor(err?.code));
      });
  }, [onCheck, onDone]);

  // The tab regaining focus during the follow step is one "I came back" signal, same idea as the
  // redirect-and-return tasks; the explicit Check button is the other.
  useEffect(() => {
    if (phase !== 'follow') return undefined;
    const onFocus = () => {
      if (!busy) check();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [phase, busy, check]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      {phase === 'handle' ? (
        <form className="modal" onSubmit={submitHandle}>
          <div className="modal-title">{t('tasks.instagramHandleTitle')}</div>
          <div className="modal-sub">
            {error ? <span className="lead-error">{t(error)}</span> : t('tasks.instagramHandleSub')}
          </div>
          <div className="ig-handle-field">
            <span className="ig-handle-at" aria-hidden="true">
              @
            </span>
            <input
              ref={inputRef}
              className="ig-handle-input"
              type="text"
              inputMode="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={30}
              value={handle}
              onChange={(e) => setHandle(e.target.value.replace(/^@+/, ''))}
              placeholder={t('tasks.instagramHandlePlaceholder')}
              aria-label={t('tasks.instagramHandleTitle')}
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onCancel}>
              {t('tasks.cancel')}
            </button>
            <button type="submit" className="btn-primary" disabled={busy || !handle.trim()}>
              {t('tasks.instagramFollowCta')}
            </button>
          </div>
        </form>
      ) : (
        <div className="modal">
          <div className="modal-title">{t('tasks.instagramFollowTitle')}</div>
          <div className="modal-sub">
            {error ? <span className="lead-error">{t(error)}</span> : t('tasks.instagramFollowSub')}
          </div>
          <button
            type="button"
            className="link-btn ig-open-again"
            onClick={() => openInstagram(urlsRef.current.appUrl, urlsRef.current.profileUrl)}
          >
            {t('tasks.instagramOpenAgain')}
          </button>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onCancel}>
              {t('tasks.cancel')}
            </button>
            <button type="button" className="btn-primary" onClick={check} disabled={busy}>
              {busy ? t('tasks.instagramChecking') : t('tasks.instagramCheckCta')}
            </button>
          </div>
        </div>
      )}
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
 *   - 'instagram': ticket K3 - opens the handle-then-follow-then-check modal; the server proves
 *     the follow through BoxAPI and releases the reward, never the client.
 *   - 'manual' (kept for future use; none seeded): the old instant-claim / PIN-gated path.
 */
export default function Tasks({
  tasksRows = [],
  onClaim,
  onRefreshTasks,
  onReportVideoProgress,
  onStartTaskVisit,
  onReturnTaskVisit,
  onInstagramStart,
  onInstagramCheck,
  onOpenIdentity,
  onToast,
}) {
  const { t, lang } = useLang();
  const [now, setNow] = useState(Date.now());
  const [waiting, setWaiting] = useState({}); // task id -> window-close timestamp
  const [pinFor, setPinFor] = useState(null);
  const [videoTask, setVideoTask] = useState(null);
  const [ytCooldownUntil, setYtCooldownUntil] = useState(() => readYoutubeCooldown());
  // Instagram (ticket K3): the modal is open while the player enters a handle / follows / checks;
  // igNotConfigured latches once the server says the BoxAPI token is missing (the B8 "coming
  // soon" state). The done state is read straight off the task row's `claimed`, not tracked here.
  const [igModalOpen, setIgModalOpen] = useState(false);
  const [igNotConfigured, setIgNotConfigured] = useState(false);
  const pendingReturns = useRef(new Set());
  const returnTimers = useRef(new Map());
  const ytClaimedBaseline = useRef(null);

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
      if (igNotConfigured) return; // coming soon: the button is disabled anyway
      setIgModalOpen(true);
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

  const instagramRow = tasksRows.find((r) => r.id === 'instagram');
  const instagramDone = Boolean(instagramRow?.claimed);
  const instagramBannerText = instagramDone
    ? t('tasks.instagramDone')
    : igNotConfigured
      ? t('tasks.instagramComingSoon')
      : null;

  // The three YouTube reward rows, collapsed into one "x of 3" mission. They complete in id order;
  // the current video is the first unclaimed one, and the whole mission is done when all are
  // claimed. Each reward is released by the server from validated watch time (report_video_progress,
  // db/schema.sql) - the client only decides which video to show and paces the unlocks.
  const ytRows = YT_MISSION_IDS.map((id) => tasksRows.find((r) => r.id === id)).filter(Boolean);
  const ytLoaded = ytRows.length === YT_MISSION_IDS.length;
  const ytClaimedCount = ytRows.filter((r) => r.claimed).length;
  const ytFirstUnclaimed = ytRows.findIndex((r) => !r.claimed);
  const ytDone = ytLoaded && ytFirstUnclaimed === -1;
  const ytCurrent = ytDone ? null : ytRows[ytFirstUnclaimed] || null;
  const ytStep = ytDone ? YT_MISSION_IDS.length : ytFirstUnclaimed + 1;
  const ytCooldownLeft = Math.max(0, ytCooldownUntil - now);
  // Video 1 is always available; a later video is gated only while its 3-minute unlock is running.
  const ytWaiting = !ytDone && ytStep > 1 && ytCooldownLeft > 0;

  // Start the 3-minute unlock the moment the server releases a video's reward (the claim count
  // rises). The baseline is captured on the first fully-loaded render so a returning player whose
  // earlier videos are already claimed does not trip a fresh cooldown, and no cooldown is set after
  // the final video since there is nothing left to unlock.
  useEffect(() => {
    if (!ytLoaded) return;
    if (ytClaimedBaseline.current === null) {
      ytClaimedBaseline.current = ytClaimedCount;
      return;
    }
    if (ytClaimedCount > ytClaimedBaseline.current) {
      if (ytClaimedCount < YT_MISSION_IDS.length) {
        const until = Date.now() + YT_COOLDOWN_MS;
        setYtCooldownUntil(until);
        writeYoutubeCooldown(until);
      } else {
        clearYoutubeCooldown();
        setYtCooldownUntil(0);
      }
    }
    ytClaimedBaseline.current = ytClaimedCount;
  }, [ytLoaded, ytClaimedCount]);

  return (
    <section className="tasks">
      <div className="screen-head">
        <div className="screen-title">{t('tasks.title')}</div>
        <div className="screen-sub">{t('tasks.sub')}</div>
      </div>
      {instagramBannerText && (
        <div
          className={`instagram-status ${instagramDone ? 'instagram-status-done' : 'instagram-status-soon'}`}
          role="status"
        >
          {instagramBannerText}
        </div>
      )}
      <div className="task-list">
        {tasksRows.map((row) => {
          // Collapse the three YouTube reward rows into one "Watch xChief videos" mission that
          // shows "x of 3" and walks the current video only. The mission takes youtube_1's slot;
          // the other two never render a row of their own.
          if (row.id === 'youtube_2' || row.id === 'youtube_3') return null;
          if (row.id === 'youtube_1') {
            return (
              <div key="youtube_videos" className={`task ${ytDone ? 'task-done' : ''}`}>
                <div className="task-icon" aria-hidden="true">
                  {TASK_ICONS.youtube_videos || '▷'}
                </div>
                <div className="task-body">
                  <div className="task-title">{t('tasks.items.youtube_videos.title')}</div>
                  <div className="task-desc">
                    {t('tasks.items.youtube_videos.desc')}
                    {' · '}
                    <span dir="ltr">
                      {t('tasks.videoStep', {
                        n: num(ytStep, lang),
                        total: num(YT_MISSION_IDS.length, lang),
                      })}
                    </span>
                  </div>
                </div>
                <div className="task-side">
                  <div className="task-reward" dir="ltr">
                    {t('tasks.reward', { n: num((ytCurrent || row).reward, lang) })}
                  </div>
                  {ytDone && <div className="task-state">{t('tasks.claimed')}</div>}
                  {!ytDone && ytWaiting && (
                    <button type="button" className="task-btn" disabled>
                      {t('tasks.videoCooldown', { t: formatCountdown(ytCooldownLeft) })}
                    </button>
                  )}
                  {!ytDone && !ytWaiting && ytCurrent && (
                    <button type="button" className="task-btn" onClick={() => setVideoTask(ytCurrent)}>
                      {t('tasks.start')}
                    </button>
                  )}
                </div>
              </div>
            );
          }
          const st = statusOf(row);
          const item = `tasks.items.${row.id}`;
          const done = st.kind === 'claimed';
          const notConfigured = row.kind === 'instagram' && igNotConfigured;
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
      {igModalOpen && (
        <InstagramModal
          onStart={onInstagramStart}
          onCheck={onInstagramCheck}
          onNotConfigured={() => setIgNotConfigured(true)}
          onDone={() => {
            setIgModalOpen(false);
            onRefreshTasks?.();
          }}
          onCancel={() => setIgModalOpen(false)}
        />
      )}
    </section>
  );
}
