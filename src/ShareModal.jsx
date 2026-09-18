import { useEffect, useState } from 'react';
import { JOIN_URL, levelFor } from './config.js';
import { num, useLang } from './i18n.js';
import { renderRecordBadge } from './shareBadge.js';

const IMAGE_NAME = 'xchief-gold-rush-record.png';

/**
 * Share my record as an image (no public page, no copy-link). The record is drawn client-side
 * into a premium badge (src/shareBadge.js) and exported to a PNG File. On a device that can share
 * files, one primary "Share" button opens the OS share sheet with the image attached and the join
 * link as the shared URL - the user picks X / Telegram / Instagram / WhatsApp themselves. Where
 * file sharing is unavailable (most desktops), it falls back to downloading the PNG and shows the
 * join link as plain, selectable text.
 */
export default function ShareModal({ profile, onClose, onToast }) {
  const { t, lang } = useLang();
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [canShareFiles, setCanShareFiles] = useState(false);

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

  const onShare = async () => {
    if (!file) return;
    const text = t('profile.shareText', { record: num(record, lang), level: levelName, url: JOIN_URL });
    try {
      await navigator.share({ files: [file], text, url: JOIN_URL });
    } catch (err) {
      // The user dismissing the share sheet rejects with AbortError - that is not a failure.
      if (err?.name === 'AbortError') return;
      onToast?.(t('share.failed'));
    }
  };

  const onDownload = () => {
    if (!previewUrl) return;
    const a = document.createElement('a');
    a.href = previewUrl;
    a.download = IMAGE_NAME;
    document.body.appendChild(a);
    a.click();
    a.remove();
    onToast?.(t('share.saved'));
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('share.heading')}>
      <div className="modal share-modal">
        <div className="modal-title">{t('share.heading')}</div>

        <div className="share-badge">
          {previewUrl ? (
            <img className="share-badge-img" src={previewUrl} alt={t('share.heading')} />
          ) : (
            <div className="share-badge-loading">{t('share.preparing')}</div>
          )}
        </div>

        {canShareFiles ? (
          <button type="button" className="btn-primary share-primary" onClick={onShare} disabled={!file}>
            {t('share.shareBtn')}
          </button>
        ) : (
          <div className="share-fallback">
            <button type="button" className="btn-primary share-primary" onClick={onDownload} disabled={!previewUrl}>
              {t('share.download')}
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
