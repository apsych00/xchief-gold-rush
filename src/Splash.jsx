/**
 * The first frame. Covers the app while the session is still connecting, so nothing
 * identity-dependent can paint before the server has said who this player is.
 *
 * It exists for correctness as much as for looks: every "do we already have this player's email"
 * guard reads a flag that is false until getMe() answers, so anything rendered in that window is
 * rendering against an identity the app has not been told yet. One gate over the whole app is
 * much harder to forget than a placeholder per screen.
 *
 * It also gives the web fonts a moment to land. The app's own layout shifts when Space Grotesk
 * swaps in, which is visible on a cold load and has made at least one layout test flaky.
 *
 * Purely presentational - useBootReady.js owns when it goes away.
 */
import Logo from './Logo.jsx';

export default function Splash({ leaving }) {
  return (
    <div className={leaving ? 'splash splash-leaving' : 'splash'} role="status" aria-live="polite">
      <div className="splash-art" aria-hidden="true">
        <div className="splash-ring" />
        <div className="splash-glow" />
        <img
          className="splash-gold"
          src="/hero-gold.webp"
          srcSet="/hero-gold.webp 640w, /hero-gold@2x.webp 1024w"
          sizes="200px"
          alt=""
          draggable={false}
        />
      </div>
      <div className="splash-brand">
        <Logo height={22} />
      </div>
      <div className="splash-title">Gold Rush</div>
      {/* The only moving part, so a slow connection still looks alive rather than stuck. */}
      <div className="splash-bar" aria-hidden="true">
        <span />
      </div>
      <span className="splash-sr">Loading</span>
    </div>
  );
}
