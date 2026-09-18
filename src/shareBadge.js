/**
 * Renders a player's record as a premium share badge, entirely client-side on a canvas - no
 * server round-trip, no public page. The badge is a portrait "pass" in the brand's dark green and
 * gold, carrying the record, the player's level, xChief branding and a QR that encodes the join
 * link. The caller turns the result into a File and hands it to navigator.share (see ShareModal).
 *
 * Dependency-free drawing: the only import is the `qrcode` package already in the app for the
 * kiosk QR. Text strings are passed in already localized, so this module stays pure - it knows how
 * to paint a badge, not which language the app is in.
 */
import QRCode from 'qrcode';

const W = 1080;
const H = 1350;

// Brand palette (mirrors src/styles.css :root and Logo.jsx).
const GOLD = '#e9b62a';
const GOLD_LIGHT = '#ffe38a';
const INK = '#03160d';

// The header logo asset (see Logo.jsx) is loaded and drawn as-is so the badge carries the exact
// same mark + wordmark as the app header, not a redrawn approximation.
const LOGO_CANDIDATES = ['/logo.svg', '/logo.png'];

const FONT_NUM = '"Space Grotesk", system-ui, sans-serif';

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

async function loadFonts() {
  if (!document.fonts?.load) return;
  try {
    await Promise.all([
      document.fonts.load(`900 210px ${FONT_NUM}`),
      document.fonts.load(`700 30px ${FONT_NUM}`),
      document.fonts.load(`800 34px ${FONT_NUM}`),
    ]);
  } catch {
    /* a font that fails to load just falls back to the next in its stack - the badge still renders */
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Same candidate chain as Logo.jsx: try the official SVG first, fall back to a PNG if present. If
// neither loads, the badge still renders - just without the lockup - rather than failing the share.
async function loadHeaderLogo() {
  for (const src of LOGO_CANDIDATES) {
    try {
      return await loadImage(src);
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('canvas_to_blob_failed'));
    }, 'image/png');
  });
}

/**
 * Draw the badge and return both a PNG Blob (for a File to share) and a data URL (for an <img>
 * preview). `labels` carries the already-localized strings (including the formatted record); `level`
 * is the player's tier title and `joinUrl` the link the QR encodes.
 */
export async function renderRecordBadge({ level, joinUrl, labels }) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  await loadFonts();
  const logoImg = await loadHeaderLogo();

  // The QR is dark ink on a cream field for reliable scanning, then framed in gold on the badge.
  const qrSrc = await QRCode.toDataURL(joinUrl, {
    margin: 1,
    width: 260,
    color: { dark: INK, light: '#f6ecca' },
  });
  const qrImg = await loadImage(qrSrc);

  // Background: deep green gradient.
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#03160d');
  bg.addColorStop(0.55, '#062012');
  bg.addColorStop(1, '#010a06');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Gold glow behind the record.
  const glow = ctx.createRadialGradient(W / 2, H * 0.42, 30, W / 2, H * 0.42, 640);
  glow.addColorStop(0, 'rgba(233, 182, 42, 0.22)');
  glow.addColorStop(1, 'rgba(233, 182, 42, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Gold frame.
  const m = 46;
  roundRect(ctx, m, m, W - 2 * m, H - 2 * m, 46);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(233, 182, 42, 0.55)';
  ctx.stroke();
  roundRect(ctx, m + 10, m + 10, W - 2 * (m + 10), H - 2 * (m + 10), 38);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.stroke();

  ctx.textAlign = 'center';

  // Brand lockup: the real header logo asset, drawn at its native aspect ratio so the badge
  // matches Logo.jsx pixel-for-pixel instead of a redrawn approximation.
  if (logoImg) {
    const logoH = 140;
    const logoW = logoH * (logoImg.width / logoImg.height);
    ctx.drawImage(logoImg, W / 2 - logoW / 2, 190, logoW, logoH);
  }

  // Eyebrow.
  ctx.font = `700 30px ${FONT_NUM}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
  ctx.letterSpacing = '8px';
  ctx.fillText(labels.eyebrow, W / 2 + 4, 430);
  ctx.letterSpacing = '0px';

  // Record number, gold with a soft glow.
  const numGrad = ctx.createLinearGradient(0, 470, 0, 700);
  numGrad.addColorStop(0, GOLD_LIGHT);
  numGrad.addColorStop(1, GOLD);
  ctx.font = `900 210px ${FONT_NUM}`;
  ctx.fillStyle = numGrad;
  ctx.shadowColor = 'rgba(233, 182, 42, 0.45)';
  ctx.shadowBlur = 46;
  ctx.fillText(labels.record, W / 2, 660);
  ctx.shadowBlur = 0;

  // Unit.
  ctx.font = `700 34px ${FONT_NUM}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
  ctx.letterSpacing = '10px';
  ctx.fillText(labels.unit, W / 2 + 5, 720);
  ctx.letterSpacing = '0px';

  // Level chip.
  const chipText = level.toUpperCase();
  ctx.font = `800 34px ${FONT_NUM}`;
  const chipW = ctx.measureText(chipText).width + 72;
  const chipH = 74;
  const chipX = W / 2 - chipW / 2;
  const chipY = 792;
  roundRect(ctx, chipX, chipY, chipW, chipH, chipH / 2);
  ctx.fillStyle = 'rgba(6, 215, 0, 0.14)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(53, 227, 111, 0.7)';
  ctx.stroke();
  ctx.fillStyle = '#6df39b';
  ctx.fillText(chipText, W / 2, chipY + 50);

  // Tagline.
  ctx.font = `600 36px ${FONT_NUM}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.fillText(labels.tagline, W / 2, 940);

  // QR block: cream card, framed in gold, with a scan prompt beside it.
  const qrSize = 232;
  const qrX = W / 2 - qrSize / 2;
  const qrY = 1010;
  roundRect(ctx, qrX - 16, qrY - 16, qrSize + 32, qrSize + 32, 24);
  ctx.fillStyle = '#f6ecca';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(233, 182, 42, 0.8)';
  ctx.stroke();
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);

  ctx.font = `700 30px ${FONT_NUM}`;
  ctx.fillStyle = GOLD;
  ctx.letterSpacing = '4px';
  ctx.fillText(labels.scan.toUpperCase(), W / 2, qrY + qrSize + 72);
  ctx.letterSpacing = '0px';

  const dataUrl = canvas.toDataURL('image/png');
  const blob = await canvasToBlob(canvas);
  return { blob, dataUrl };
}
