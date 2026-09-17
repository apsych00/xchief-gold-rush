/**
 * The booth visitor flow (ticket C2, docs/layers.md). Rendered by App.jsx in place of the whole
 * web tree (Home/Leaderboard/Tasks/Nav) whenever IS_KIOSK is true, so the hard guarantee "no
 * email, task, leaderboard, or lead-capture UI can render in kiosk mode" holds by construction:
 * none of those components are imported here at all. TopBar and Console are reused unchanged
 * from App.jsx - the play screen itself (idle/running/result) is identical to the web's, just
 * wrapped by ATTRACT/WON/BROKE instead of Home/Leaderboard/Tasks.
 */
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Console, TopBar } from './App.jsx';
import { num, useLang } from './i18n.js';
import { QR_MS, useKioskFlow } from './useKioskFlow.js';

// showButton is false for the no_codes screen (ticket C8, docs/layers.md): same attract
// screen, minus the Play button, while KioskNoCodesModal sits on top of it.
function KioskAttract({ onTap, showButton = true, streakTarget }) {
  return (
    <section className="home kiosk-attract-in">
      <div className="home-question">Predict gold. Win a prize.</div>
      <div className="hero" aria-hidden="true">
        <div className="hero-ring" />
        <div className="hero-glow" />
        <img
          className="hero-art"
          src="/hero-gold.webp"
          srcSet="/hero-gold.webp 640w, /hero-gold@2x.webp 1024w"
          sizes="(max-width: 430px) 60vw, 260px"
          alt=""
          draggable={false}
        />
      </div>
      {showButton && (
        <div className="home-cta">
          <button type="button" className="btn-start" onClick={onTap}>
            Tap to play
          </button>
          <div className="home-rules">
            {/* streakTarget (ticket C9 decision 1) comes from the server's kiosk_session frame,
                never a number baked into this file - the owner may set it to 10. */}
            Predict whether gold goes up or down in 5 seconds. {streakTarget} wins in a row wins a $100 code.
          </div>
        </div>
      )}
    </section>
  );
}

// The QR claim screen (ticket C9, docs/tickets/c9-qr-claim.md), replacing the old WIN modal's
// on-screen code entirely - the kiosk client never learns the code itself, only claim_url.
function KioskWonModal({ claimUrl, secondsLeft, onScanned }) {
  const { t } = useLang();
  const [qrSrc, setQrSrc] = useState(null);
  // Fixed once per mount: the countdown bar's own denominator, read from the same DEV-only hook
  // src/useKioskFlow.js's timer reads, so a test that shrinks QR_MS still sees a bar that reaches
  // full width exactly when the button's own timer resets the kiosk.
  const totalSecRef = useRef(
    Math.ceil(((import.meta.env.DEV && window.__xchief?.kioskTiming?.QR_MS) || QR_MS) / 1000),
  );

  useEffect(() => {
    if (!claimUrl) {
      setQrSrc(null);
      return undefined;
    }
    let cancelled = false;
    QRCode.toDataURL(claimUrl, { margin: 1, width: 220 }).then((url) => {
      if (!cancelled) setQrSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [claimUrl]);

  const totalSec = totalSecRef.current;
  const pct = secondsLeft == null ? 0 : Math.max(0, Math.min(100, ((totalSec - secondsLeft) / totalSec) * 100));

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('kioskWin.qrTitleEn')}>
      <div className="modal kiosk-modal kiosk-qr-modal">
        <div className="modal-title" dir="rtl">
          {t('kioskWin.qrTitleFa')}
        </div>
        <div className="modal-sub">{t('kioskWin.qrTitleEn')}</div>
        <div className="kiosk-qr-wrap">
          {qrSrc ? (
            <img className="kiosk-qr" src={qrSrc} alt="" width={200} height={200} />
          ) : (
            <div className="kiosk-qr kiosk-qr-loading" aria-hidden="true" />
          )}
        </div>
        <div className="promo-bar">
          <div className="promo-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn-primary kiosk-modal-btn" onClick={onScanned}>
            {t('kioskWin.scannedBtnFa')} / {t('kioskWin.scannedBtnEn')}
          </button>
        </div>
      </div>
    </div>
  );
}

function KioskBrokeModal({ secondsLeft, onDone }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Out of coins">
      <div className="modal kiosk-modal">
        <div className="modal-title">That was your shot</div>
        <div className="modal-sub">You have used all your coins - time to let the next player in.</div>
        <div className="modal-sub">Resetting in {secondsLeft ?? ''}s</div>
        <div className="modal-actions">
          <button type="button" className="btn-primary kiosk-modal-btn" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function KioskAbandonOverlay({ secondsLeft, onTap }) {
  return (
    <div
      className="modal-backdrop"
      role="alertdialog"
      aria-live="assertive"
      aria-label="Still there"
      onClick={onTap}
    >
      <div className="modal kiosk-modal">
        <div className="modal-title">Still there?</div>
        <div className="modal-sub">Resetting in {secondsLeft}s - tap anywhere to keep playing</div>
      </div>
    </div>
  );
}

// No buttons, no countdown (ticket C8, docs/layers.md): this clears itself when the next
// kiosk_session frame reports codes_left > 0, staff loading coupons is the only recovery.
function KioskNoCodesModal() {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="No prizes left">
      <div className="modal kiosk-modal">
        <div className="modal-title">All the prizes are gone</div>
        <div className="modal-sub">
          Every $100 code for today has been won. Tell someone at the xChief booth you&apos;d like to play - they
          can load more prizes in a minute.
        </div>
        <div className="modal-sub">This screen updates by itself.</div>
      </div>
    </div>
  );
}

// Ticket C11: the real kiosk intro (A6) on the B10 once-per-boot mount point, shown between
// ATTRACT and the first play. One card, both languages at once like the C9 QR screen, larger
// type for the booth. The streak target comes from the server's kiosk_session frame
// (useKioskFlow's streakTarget, default 5 before the first frame), never a number baked in here.
function KioskIntroModal({ streakTarget, onDone }) {
  const { t } = useLang();
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('kioskIntro.en', { n: streakTarget })}
    >
      <div className="modal kiosk-modal kiosk-intro">
        <div className="modal-title" dir="rtl">
          {t('kioskIntro.fa', { n: num(streakTarget, 'fa') })}
        </div>
        <div className="modal-sub">{t('kioskIntro.en', { n: streakTarget })}</div>
        <div className="modal-actions">
          <button type="button" className="btn-primary kiosk-modal-btn" onClick={onDone}>
            Start
          </button>
        </div>
      </div>
    </div>
  );
}

// D7 (docs/reports/redteam.md): the same overlay a dropped connection shows, with one added
// line when the server rejected this kiosk's secret (revoked, empty, too short) - reconnecting
// keeps retrying but can never succeed on its own, so this is the booth's only signal to call
// staff rather than wait it out.
function KioskReconnecting({ unauthorized }) {
  return (
    <div className="modal-backdrop" role="status" aria-live="assertive">
      <div className="modal kiosk-modal">
        <div className="modal-title kiosk-reconnect-title">Reconnecting…</div>
        {unauthorized && <div className="modal-sub">Kiosk not configured. Tell the booth staff.</div>}
      </div>
    </div>
  );
}

export default function KioskApp({ state, profile, actions, trackRef }) {
  const flow = useKioskFlow({ onReturnToAttract: actions.goHome });
  const showAttractScreen = flow.screen === 'attract' || flow.screen === 'no_codes';

  return (
    <>
      <TopBar profile={profile} />
      {showAttractScreen && (
        <KioskAttract
          onTap={flow.startPlaying}
          showButton={flow.screen === 'attract'}
          streakTarget={flow.streakTarget}
        />
      )}
      {!showAttractScreen && (
        <Console state={state} profile={profile} actions={actions} trackRef={trackRef} />
      )}
      {flow.screen === 'won' && (
        <KioskWonModal claimUrl={flow.claimUrl} secondsLeft={flow.modalSecondsLeft} onScanned={flow.claimOrDone} />
      )}
      {flow.screen === 'broke' && (
        <KioskBrokeModal secondsLeft={flow.modalSecondsLeft} onDone={flow.claimOrDone} />
      )}
      {flow.screen === 'no_codes' && <KioskNoCodesModal />}
      {flow.abandonSecondsLeft !== null && (
        <KioskAbandonOverlay secondsLeft={flow.abandonSecondsLeft} onTap={flow.cancelAbandon} />
      )}
      {flow.showIntro && <KioskIntroModal streakTarget={flow.streakTarget} onDone={flow.dismissIntro} />}
      {(flow.reconnecting || flow.kioskUnauthorized) && (
        <KioskReconnecting unauthorized={flow.kioskUnauthorized} />
      )}
    </>
  );
}
