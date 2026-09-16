/**
 * The booth visitor flow (ticket C2, docs/layers.md). Rendered by App.jsx in place of the whole
 * web tree (Home/Leaderboard/Tasks/Nav) whenever IS_KIOSK is true, so the hard guarantee "no
 * email, task, leaderboard, or lead-capture UI can render in kiosk mode" holds by construction:
 * none of those components are imported here at all. TopBar and Console are reused unchanged
 * from App.jsx - the play screen itself (idle/running/result) is identical to the web's, just
 * wrapped by ATTRACT/WON/BROKE instead of Home/Leaderboard/Tasks.
 */
import { Console, TopBar } from './App.jsx';
import { useKioskFlow } from './useKioskFlow.js';

function KioskAttract({ onTap }) {
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
      <div className="home-cta">
        <button type="button" className="btn-start" onClick={onTap}>
          Tap to play
        </button>
        <div className="home-rules">
          Predict whether gold goes up or down in 5 seconds. Five wins in a row wins a $100 code.
        </div>
      </div>
    </section>
  );
}

function KioskWonModal({ coupon, secondsLeft, onClaim }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="You won">
      <div className="modal kiosk-modal">
        <div className="modal-title">You won!</div>
        <div className="modal-sub">Get your phone ready - photograph this code</div>
        <div className="kiosk-code" dir="ltr">
          {coupon || '----'}
        </div>
        <div className="modal-sub">Claim within {secondsLeft ?? ''}s</div>
        <div className="modal-actions">
          <button type="button" className="btn-primary kiosk-modal-btn" onClick={onClaim}>
            Claim
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

function KioskReconnecting() {
  return (
    <div className="modal-backdrop" role="status" aria-live="assertive">
      <div className="modal kiosk-modal">
        <div className="modal-title kiosk-reconnect-title">Reconnecting…</div>
      </div>
    </div>
  );
}

export default function KioskApp({ state, profile, actions, trackRef }) {
  const flow = useKioskFlow({ onReturnToAttract: actions.goHome });

  return (
    <>
      <TopBar profile={profile} />
      {flow.screen === 'attract' && <KioskAttract onTap={flow.startPlaying} />}
      {flow.screen !== 'attract' && (
        <Console state={state} profile={profile} actions={actions} trackRef={trackRef} />
      )}
      {flow.screen === 'won' && (
        <KioskWonModal coupon={flow.coupon} secondsLeft={flow.modalSecondsLeft} onClaim={flow.claimOrDone} />
      )}
      {flow.screen === 'broke' && (
        <KioskBrokeModal secondsLeft={flow.modalSecondsLeft} onDone={flow.claimOrDone} />
      )}
      {flow.abandonSecondsLeft !== null && (
        <KioskAbandonOverlay secondsLeft={flow.abandonSecondsLeft} onTap={flow.cancelAbandon} />
      )}
      {flow.reconnecting && <KioskReconnecting />}
    </>
  );
}
