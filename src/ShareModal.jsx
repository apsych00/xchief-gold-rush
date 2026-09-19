import { useEffect, useRef, useState } from 'react';
import { JOIN_URL, levelFor } from './config.js';
import { num, useLang } from './i18n.js';
import { renderRecordBadge } from './shareBadge.js';

const IMAGE_NAME = 'xchief-gold-rush-record.png';

// Share your record mission (kind='manual', db/seed.sql's 'story' row): the countdown length
// after the primary button is pressed, matching the pacing of the other fake-timer missions
// (Instagram's INSTAGRAM_GRANT_COUNTDOWN_S in src/Tasks.jsx). Purely cosmetic - the claim below
// only fires once this runs out, but nothing here proves the share actually completed; that is
// the same trust boundary claim_task already accepts for a 'manual' task (AGENTS.md, db/schema.sql
// decision 5), not something this screen widens.
const MISSION_COUNTDOWN_S = 3;

/**
 * Share my record as an image (no public page, no copy-link). The record is drawn client-side
 * into a premium badge (src/shareBadge.js) and exported to a PNG File. On a device that can share
 * files, one primary "Share" button opens the OS share sheet with the image attached and the join
 * link as the shared URL - the user picks X / Telegram / Instagram / WhatsApp themselves. Where
 * file sharing is unavailable (most desktops), it falls back to downloading the PNG and shows the
 * join link as plain, selectable text.
 *
 * `mission`, when set, means this modal was opened from the "Share your record" mission row on
 * Tasks (src/Tasks.jsx -> Profile.jsx), not the standalone profile share button. In that mode the
 * primary button (Share or Download, whichever renders) also starts a 3 s countdown; only once it
 * finishes does `mission.onClaim()` fire and the modal close itself. Closing early, or never
 * pressing the button at all, claims nothing - the interval is cleared on unmount so an abandoned
 * modal can never grant after the fact.
 */
export default function ShareModal({ profile, onClose, onToast, mission }) {
  const { t, lang } = useLang();
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [canShareFiles, setCanShareFiles] = useState(false);
  const [counting, setCounting] = useState(null); // seconds left in the mission countdown, or null
  const countdownRef = useRef(null);

  const record = profile.record;
  const level = levelFor(record);
  const levelName = t(`level.${level.id}`);

  useEffect(() => {
    let cancelled = false;
    renderRecordBadge({
      level: levelName,
      joinUrl: JOIN_URL,
      labels: {
        eyebrow: t('share.badgeEyebrow'),
        unit: t('share.badgeUnit'),
        tagline: t('share.badgeTagline'),
        scan: t('share.badgeScan'),
        record: num(record, lang),
      },
    })
      .then(({ blob, dataUrl }) => {
        if (cancelled) return;
        const pngFile = new File([blob], IMAGE_NAME, { type: 'image/png' });
        setFile(pngFile);
        setPreviewUrl(dataUrl);
        setCanShareFiles(
          typeof navigator !== 'undefined' &&
            typeof navigator.canShare === 'function' &&
            navigator.canShare({ files: [pngFile] }),
        );
      })
      .catch(() => {
        if (!cancelled) onToast?.(t('share.failed'));
      });
    return () => {
      cancelled = true;
    };
    // Re-render only when the record or language changes; t is stable per language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, lang]);

  // The countdown runs only while this modal is mounted; unmounting (close, or navigating away
  // from Profile) clears it, so an abandoned modal never fires the claim after the fact.
  useEffect(
    () => () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    },
    [],
  );

  // Starts the mission's fake countdown once the primary button has been pressed. `mission.onClaim`
  // fires only when it reaches zero - never on press itself - and the modal then closes on its own,
  // same as the other reward flows closing once their server call resolves.
  const startMissionCountdown = () => {
    if (!mission || countdownRef.current) return;
    let n = MISSION_COUNTDOWN_S;
    setCounting(n);
    countdownRef.current = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
        setCounting(null);
        mission.onClaim();
        onClose();
        return;
      }
      setCounting(n);
    }, 1000);
  };

  const onShare = () => {
    if (!file || counting != null) return;
    const text = t('profile.shareText', { record: num(record, lang), level: levelName, url: JOIN_URL });
    navigator.share({ files: [file], text, url: JOIN_URL }).catch((err) => {
      // The user dismissing the share sheet rejects with AbortError - that is not a failure.
      if (err?.name === 'AbortError') return;
      onToast?.(t('share.failed'));
    });
    startMissionCountdown();
  };

  const onDownload = () => {
    if (!previewUrl || counting != null) return;
    const a = document.createElement('a');
    a.href = previewUrl;
    a.download = IMAGE_NAME;
    document.body.appendChild(a);
    a.click();
    a.remove();
    onToast?.(t('share.saved'));
    startMissionCountdown();
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('share.heading')}>
      <div className="modal share-modal">
        <div className="modal-title">{t('share.heading')}</div>
        {mission && (
          <div className="modal-sub">{t('share.missionHint', { n: num(mission.reward, lang) })}</div>
        )}

        <div className="share-badge">
          {previewUrl ? (
            <img className="share-badge-img" src={previewUrl} alt={t('share.heading')} />
          ) : (
            <div className="share-badge-loading">{t('share.preparing')}</div>
          )}
        </div>

        {canShareFiles ? (
          <button
            type="button"
            className="btn-primary share-primary"
            onClick={onShare}
            disabled={!file || counting != null}
          >
            {counting != null ? t('share.missionCountdown', { n: counting }) : t('share.shareBtn')}
          </button>
        ) : (
          <div className="share-fallback">
            <button
              type="button"
              className="btn-primary share-primary"
              onClick={onDownload}
              disabled={!previewUrl || counting != null}
            >
              {counting != null ? t('share.missionCountdown', { n: counting }) : t('share.download')}
            </button>
            <div className="share-join">
              <span className="share-join-label">{t('share.joinLabel')}</span>
              <span className="share-join-url" dir="ltr">
                {JOIN_URL}
              </span>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('share.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
