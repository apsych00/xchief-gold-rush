# iPad kiosk layout fix report

Fixed the kiosk tablet layout so it fills every iPad viewport instead of rendering as a 430px phone strip.

## Root cause

`src/styles.css` gated the kiosk tablet styling behind `@media (min-width: 1000px) and (min-height: 1000px)`. Only the 13-inch iPad Pro satisfied both dimensions in portrait; every other iPad fell back to the phone default (`max-width: 430px`). The same gate appeared at lines 2451, 2729, 2757 and 3235.

## Fix

Changed the tablet gates in `src/styles.css`:

- Portrait: `@media (min-width: 744px) and (min-height: 1000px)` - covers iPad mini, Air 11, Pro 11 and Pro 13 portrait.
- Landscape: `@media (min-width: 1000px) and (min-height: 700px) and (orientation: landscape)` - covers all iPad landscape sizes.

The same split was applied to both the kiosk block and the web large-display block so the two stay consistent. Phones stay untouched because no phone viewport reaches 744px+ width with 1000px+ height, nor 1000px+ width with 700px+ height.

## Before

| device | orientation | viewport | .phone width | scroll | clip |
|---|---|---|---|---|---|
| iPad Air 11 | portrait | 820 x 1180 | 430px | pass | pass |
| iPad Air 11 | landscape | 1180 x 820 | 430px | pass | pass |
| iPad Pro 13 | portrait | 1024 x 1366 | 993px | pass | pass |
| iPad Pro 13 | landscape | 1366 x 1024 | 1284px | pass | pass |
| iPad Pro 11 | portrait | 834 x 1194 | 430px | pass | pass |
| iPad Pro 11 | landscape | 1194 x 834 | 430px | pass | pass |
| iPad mini | portrait | 744 x 1133 | 430px | pass | pass |
| iPad mini | landscape | 1133 x 744 | 430px | pass | pass |
| iPhone 15 Pro Max | portrait | 430 x 932 | 430px | pass | pass |

## After

| device | orientation | viewport | .phone width | scroll | clip |
|---|---|---|---|---|---|
| iPad Air 11 | portrait | 820 x 1180 | 795px | pass | pass |
| iPad Air 11 | landscape | 1180 x 820 | 1109px | pass | pass |
| iPad Pro 13 | portrait | 1024 x 1366 | 993px | pass | pass |
| iPad Pro 13 | landscape | 1366 x 1024 | 1284px | pass | pass |
| iPad Pro 11 | portrait | 834 x 1194 | 809px | pass | pass |
| iPad Pro 11 | landscape | 1194 x 834 | 1122px | pass | pass |
| iPad mini | portrait | 744 x 1133 | 722px | pass | pass |
| iPad mini | landscape | 1133 x 744 | 1065px | pass | pass |
| iPhone 15 Pro Max | portrait | 430 x 932 | 430px | pass | pass |

## Evidence

Screenshots captured at each viewport are in `docs/reports/ipad/`:

- `ipad-air-11-portrait.png`
- `ipad-air-11-landscape.png`
- `ipad-pro-11-portrait.png`
- `ipad-pro-11-landscape.png`
- `ipad-pro-13-portrait.png`
- `ipad-pro-13-landscape.png`
- `ipad-mini-portrait.png`
- `ipad-mini-landscape.png`
- `iphone-15-pro-max-portrait.png`

## Checks

- No vertical or horizontal scrolling at any viewport.
- No element extends past the viewport edges at any viewport.
- Phone web layout unchanged: iPhone 15 Pro Max keeps 430px width.

## How to verify

Run the measurement script against the Docker stack on `localhost:8080`:

```bash
npm run build
node scripts/measure-kiosk-viewports.mjs
```

The script opens `http://localhost:8080/?k=Z6gP-WEm4S3IsAA53CjCmE-4JaiA3InC`, measures the rendered `.phone` width, checks scroll and clipping, and captures one screenshot per viewport.
