# xChief animated banners — integration

Two self-contained HTML files. No build step, no external assets (fonts/logo are inlined). Drop them in your static folder and embed with an `<iframe>`.

Canvas size: **1072 × 310** (the Leaderboard promo slot @3x; aspect 3.458:1). Loops forever, silent.

## Files

- `xchief-banner-concepts.html` — 10 concepts (4 frames each, 11.5 s loop). Pick one with `?concept=N`.
- `xchief-board-banner.html` — the 6-frame Gold Rush board banner (Trust → Conditions → Security → Bonus → Compete → CTA, 20.5 s loop).

## Embed

```html
<iframe
  src="/banners/xchief-banner-concepts.html?concept=3&embed=1"
  style="width:100%;aspect-ratio:1072/310;border:0;display:block;background:#000"
  loading="lazy" title="xChief"></iframe>
```

`embed=1` hides the play bar and editor. Without it you get the scrubber for review.

## Concepts (`?concept=`)

1. Legacy & Scale
2. Global Security
3. Award-Winning Authority
4. Worldwide Community
5. Capital Protection
6. Professional Infrastructure
7. Tech & Accessibility
8. Partner Credibility
9. Institutional Support
10. Ultimate VIP / V9

Names also work: `?concept=Capital%20Protection`.

## React example

```jsx
export const Banner = ({ concept = 1 }) => (
  <iframe src={`/banners/xchief-banner-concepts.html?concept=${concept}&embed=1`}
    style={{ width: '100%', aspectRatio: '1072 / 310', border: 0, display: 'block' }} />
);
```

Rotate concepts per session (`concept = 1 + (Date.now() / 86400000 | 0) % 10`) or per user cohort.
