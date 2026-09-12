/**
 * xChief wordmark: a bold "X" whose rising stroke is a green swoosh that
 * sweeps over an italic serif "Chief". Drawn as SVG so it stays crisp on the
 * booth LCD and can take the surrounding text colour (white on the dark UI).
 *
 * If a raster brand file is preferred, drop it in `public/logo.png` and this
 * component will show it instead (falls back to the SVG if the file is
 * missing).
 */
import { useState } from 'react';

const GREEN = '#00B51D';

export function LogoMark({ size = 28, color = 'currentColor' }) {
  // Standalone "X + swoosh" mark, used for the favicon-style badge.
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <path d="M8 22h22l62 70H70L8 22z" fill={color} />
      <path d="M70 22h22L66 51 55 39 70 22z" fill={color} />
      <path d="M6 92C22 58 44 34 92 20 60 30 36 52 24 92H6z" fill={GREEN} />
    </svg>
  );
}

export default function Logo({ height = 28, className = '' }) {
  const [useImage, setUseImage] = useState(true);
  if (useImage) {
    return (
      <img
        src="/logo.png"
        alt="xChief"
        className={`logo-img ${className}`}
        style={{ height, width: 'auto' }}
        onError={() => setUseImage(false)}
        draggable={false}
      />
    );
  }
  return (
    <svg
      className={`logo-svg ${className}`}
      height={height}
      viewBox="0 0 420 120"
      role="img"
      aria-label="xChief"
      style={{ width: 'auto', display: 'block' }}
    >
      {/* falling stroke of the X */}
      <path d="M6 30h34l86 84H92L6 30z" fill="currentColor" />
      {/* short upper-right stub of the rising stroke, above the swoosh */}
      <path d="M92 30h34L98 63 82 44 92 30z" fill="currentColor" />
      {/* green swoosh: rising stroke that arcs over the wordmark */}
      <path d="M4 114C34 70 78 40 150 27c40-7 88-8 150 8-58-10-108-6-148 4-52 13-92 40-118 75H4z" fill={GREEN} />
      <text
        x="132"
        y="112"
        fontFamily="'Playfair Display', Georgia, 'Times New Roman', serif"
        fontStyle="italic"
        fontWeight="600"
        fontSize="104"
        letterSpacing="-3"
        fill="currentColor"
      >
        Chief
      </text>
    </svg>
  );
}
