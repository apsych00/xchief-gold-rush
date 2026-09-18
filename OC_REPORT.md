# Share Modal Fix - OC Report

## Changes made

- `src/ShareModal.jsx`
- `src/i18n.js`
- `src/profile-screen.css`

## What icons and links are now set

The share modal now shows exactly three shortcuts, in this order:

1. **Share to X (Twitter)**
   - Icon: inline SVG of the current X/Twitter logo.
   - Link: `https://twitter.com/intent/tweet?text=<encoded share text>`.
   - The share text is `profile.shareText`, which already includes the `/s/<token>` link returned by `getShareLink()`.

2. **Share to Telegram**
   - Icon: inline SVG paper-plane Telegram glyph.
   - Link: `https://t.me/share/url?url=<encoded share URL>&text=<encoded share text>`.
   - The `url` parameter uses `link.url` from `getShareLink()`, and the `text` parameter also includes the same URL.

3. **Copy link**
   - Icon: inline SVG copy icon (two overlapping rectangles).
   - Action: copies `link.url` to the clipboard with `navigator.clipboard.writeText` and triggers the existing toast (`share.copied` / `share.copyFailed`).

All three icons are clean inline SVGs using `fill="currentColor"`, matching how the app renders other icons. The X and Telegram links open in a new tab with `target="_blank"` and `rel="noopener noreferrer"`.

## Removed shortcuts

- WhatsApp shortcut and its `wa.me` link.
- Native `navigator.share` "More" shortcut.

## Visible share link field

The `.share-url-input` field is still present and still displays the `/s/<token>` URL produced by `getShareLink()` in `src/api/socket.js`. It is still selectable on focus and has its own Copy button, so users can both see the link and copy it directly.

## Verification

- `npm run lint` passed with no errors.
- `npm run build` completed successfully.
- The X/Telegram share intents include the share link because they use the same `shareText` / `link.url` values that populate the visible input.

## Branch

Committed on `oc/share-social`. Not pushed.
