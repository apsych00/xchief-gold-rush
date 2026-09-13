/**
 * xChief wordmark.
 *
 * `public/logo.svg` is the official logo (from xchief.com) with the dark
 * strokes recoloured white for the dark UI; `public/logo-dark.svg` is the
 * untouched original for light backgrounds. If `public/logo.png` exists it
 * is only tried if the SVG is missing, and if no file loads at all a small inline SVG keeps the
 * brand visible.
 */
import { useState } from 'react';

const GREEN = '#06D700';
// The official SVG ships with the app; a PNG is only tried if the SVG is
// missing, so production never logs a 404 probing for an optional file.
const CANDIDATES = ['/logo.svg', '/logo.png'];

export function LogoMark({ size = 28, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <path d="M8 22h22l62 70H70L8 22z" fill={color} />
      <path d="M70 22h22L66 51 55 39 70 22z" fill={color} />
      <path d="M6 92C22 58 44 34 92 20 60 30 36 52 24 92H6z" fill={GREEN} />
    </svg>
  );
}

export default function Logo({ height = 28, className = '' }) {
  const [idx, setIdx] = useState(0);
  if (idx < CANDIDATES.length) {
    return (
      <img
        src={CANDIDATES[idx]}
        alt="xChief"
        className={`logo-img ${className}`}
        style={{ height, width: 'auto' }}
        onError={() => setIdx((i) => i + 1)}
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
      <path d="M6 30h34l86 84H92L6 30z" fill="currentColor" />
      <path d="M92 30h34L98 63 82 44 92 30z" fill="currentColor" />
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
