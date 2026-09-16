import { useEffect, useRef, useState } from 'react';
import {
  PROMO_VIDEO_SECONDS,
  PROMO_VIDEO_URL,
  SHARE_URL,
  STAFF_PIN,
  TASKS,
  TASK_WAIT_MS,
  VERIFY_MODE,
} from './config.js';
import { enabled as apiEnabled } from './api/client.js';
import { num, useLang } from './i18n.js';
import LeadCapture from './LeadCapture.jsx';
import { readLead, readSignup } from './leads.js';
import Logo from './Logo.jsx';
import SignupForm from './SignupForm.jsx';

function fmtCountdown(ms, lang) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  const txt = m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
  return lang === 'fa' ? txt.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]) : txt;
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

function VideoModal({ onDone, onCancel }) {
  const { t } = useLang();
  const [left, setLeft] = useState(PROMO_VIDEO_SECONDS);
  useEffect(() => {
    if (PROMO_VIDEO_URL) return undefined;
    const id = setInterval(() => setLeft((s) => s - 1), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!PROMO_VIDEO_URL && left <= 0) onDone();
  }, [left, onDone]);
  const pct = PROMO_VIDEO_URL ? 0 : ((PROMO_VIDEO_SECONDS - left) / PROMO_VIDEO_SECONDS) * 100;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-video">
        {PROMO_VIDEO_URL ? (
          <video className="promo-video" src={PROMO_VIDEO_URL} autoPlay playsInline onEnded={onDone} />
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

export default function Tasks({ profile, tasksRows = [], onClaim, onRefreshTasks, onToast }) {
  const { t, lang } = useLang();
  const [now, setNow] = useState(Date.now());
  const [waiting, setWaiting] = useState({}); // task id -> unlock timestamp
  const [pinFor, setPinFor] = useState(null);
  const [videoOpen, setVideoOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [signupOpen, setSignupOpen] = useState(false);
  const leadSaved = !!readLead();
  const signupSaved = !!readSignup();
  const online = apiEnabled; // false only in the no-backend preview mode (VITE_GAME_WS unset)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  // A repeatable task's `claimed` flips back to false server-side once its cooldown passes
  // (public.get_tasks(), docs/layers.md C5); refetch periodically while this screen is open so
  // that happens without the player having to leave and come back.
  useEffect(() => {
    if (!apiEnabled || !onRefreshTasks) return undefined;
    const id = setInterval(onRefreshTasks, 5000);
    return () => clearInterval(id);
  }, [onRefreshTasks]);

  // Reward and claimed state (docs/layers.md C5): computed server-side by public.get_tasks()
  // and delivered on the `tasks` frame (tasksRows, refreshed by useGame's goTasks/refreshTasks)
  // - never assembled here from localStorage or a hardcoded reward table. The offline preview
  // mode (no server to ask) is the one exception, kept on the old localStorage-timestamp path.
  const rowFor = (id) => tasksRows.find((r) => r.id === id);
  const rewardOf = (task) => (online ? (rowFor(task.id)?.reward ?? task.reward) : task.reward);
  const isClaimed = (id) => (online ? !!rowFor(id)?.claimed : !!profile.taskClaims[id]);

  // Email and signup tasks auto-claim once the matching lead exists
  // (they may have been captured from a prompt elsewhere in the game).
  useEffect(() => {
    if (leadSaved && !isClaimed('email')) onClaim('email');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadSaved, tasksRows, profile.taskClaims.email, onClaim]);
  useEffect(() => {
    if (signupSaved && !isClaimed('signup')) onClaim('signup');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signupSaved, tasksRows, profile.taskClaims.signup, onClaim]);

  const statusOf = (task) => {
    if (online) {
      // The `tasks` frame's `claimed` is a plain boolean (docs/layers.md C5), not a claimed-
      // until timestamp, so a repeatable task on cooldown shows the same "claimed" state as a
      // one-time task rather than a precise countdown - it clears itself the next time this
      // screen refetches (goTasks, or the periodic refresh below).
      if (rowFor(task.id)?.claimed) return { kind: 'claimed' };
    } else {
      const last = profile.taskClaims[task.id];
      if (last) {
        if (!task.repeatMs) return { kind: 'claimed' };
        const left = task.repeatMs - (now - last);
        if (left > 0) return { kind: 'cooldown', left };
      }
    }
    const unlockAt = waiting[task.id];
    if (unlockAt) {
      if (now < unlockAt) return { kind: 'waiting', left: unlockAt - now };
      return { kind: 'ready' };
    }
    return { kind: 'available' };
  };

  const begin = (task) => {
    if (task.kind === 'video') {
      setVideoOpen(true);
      return;
    }
    if (task.kind === 'email') {
      setEmailOpen(true);
      return;
    }
    if (task.kind === 'signup') {
      setSignupOpen(true);
      return;
    }
    if (task.kind === 'share') {
      const text = t('tasks.shareText', { record: num(profile.record, lang), url: SHARE_URL });
      if (navigator.share) {
        navigator.share({ text }).catch(() => {});
      } else {
        navigator.clipboard
          ?.writeText(text)
          .then(() => onToast(t('tasks.copied')))
          .catch(() => {});
      }
    } else if (task.url) {
      window.open(task.url, '_blank', 'noopener');
    }
    setWaiting((w) => ({ ...w, [task.id]: Date.now() + TASK_WAIT_MS }));
  };

  const finish = (task) => {
    if (VERIFY_MODE === 'pin') {
      setPinFor(task.id);
      return;
    }
    grant(task.id);
  };

  const grant = (id) => {
    onClaim(id);
    setWaiting((w) => {
      const n = { ...w };
      delete n[id];
      return n;
    });
    setPinFor(null);
  };

  return (
    <section className="tasks">
      <div className="screen-head">
        <div className="screen-title">{t('tasks.title')}</div>
        <div className="screen-sub">{t('tasks.sub')}</div>
      </div>
      <div className="task-list">
        {TASKS.map((task) => {
          const st = statusOf(task);
          const item = `tasks.items.${task.id}`;
          const done = st.kind === 'claimed';
          return (
            <div key={task.id} className={`task ${task.featured ? 'task-featured' : ''} ${done ? 'task-done' : ''}`}>
              <div className="task-icon" aria-hidden="true">
                {task.icon}
              </div>
              <div className="task-body">
                <div className="task-title">{t(`${item}.title`)}</div>
                <div className="task-desc">{t(`${item}.desc`)}</div>
                {task.kind === 'email' && emailOpen && !leadSaved && (
                  <LeadCapture source="task" balance={profile.coins} variant="inline" />
                )}
                {task.kind === 'signup' && signupOpen && !signupSaved && (
                  <SignupForm
                    source="task"
                    balance={profile.coins}
                    reward={num(rewardOf(task), lang)}
                    variant="inline"
                    onCancel={() => setSignupOpen(false)}
                  />
                )}
              </div>
              <div className="task-side">
                <div className="task-reward" dir="ltr">
                  {t('tasks.reward', { n: num(rewardOf(task), lang) })}
                </div>
                {st.kind === 'claimed' && <div className="task-state">{t('tasks.claimed')}</div>}
                {st.kind === 'cooldown' && (
                  <div className="task-state">{t('tasks.again', { t: fmtCountdown(st.left, lang) })}</div>
                )}
                {st.kind === 'waiting' && (
                  <button type="button" className="task-btn" disabled>
                    {t('tasks.waiting', { s: num(Math.ceil(st.left / 1000), lang) })}
                  </button>
                )}
                {st.kind === 'ready' && (
                  <button type="button" className="task-btn task-btn-ready" onClick={() => finish(task)}>
                    {VERIFY_MODE === 'pin' ? t('tasks.verify') : t('tasks.done')}
                  </button>
                )}
                {st.kind === 'available' && task.kind !== 'email' && task.kind !== 'signup' && (
                  <button type="button" className="task-btn" onClick={() => begin(task)}>
                    {task.kind === 'link' ? t('tasks.open') : t('tasks.start')}
                  </button>
                )}
                {st.kind === 'available' && task.kind === 'email' && !emailOpen && (
                  <button type="button" className="task-btn" onClick={() => begin(task)}>
                    {t('tasks.start')}
                  </button>
                )}
                {st.kind === 'available' && task.kind === 'signup' && !signupOpen && (
                  <button type="button" className="task-btn task-btn-ready" onClick={() => begin(task)}>
                    {t('tasks.start')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {pinFor && <PinModal onOk={() => grant(pinFor)} onCancel={() => setPinFor(null)} />}
      {videoOpen && (
        <VideoModal
          onDone={() => {
            setVideoOpen(false);
            grant('video');
          }}
          onCancel={() => setVideoOpen(false)}
        />
      )}
    </section>
  );
}
