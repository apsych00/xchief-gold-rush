import { useEffect, useState } from 'react';
import { levelFor } from './config.js';
import { num, useLang } from './i18n.js';
import { LogoMark } from './Logo.jsx';
import { getShareLink } from './api/socket.js';

function ShareButton({ icon, label, href, onClick }) {
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="share-shortcut"
        aria-label={label}
      >
        <span className="share-shortcut-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="share-shortcut-label">{label}</span>
      </a>
    );
  }
  return (
    <button type="button" className="share-shortcut" onClick={onClick} aria-label={label}>
      <span className="share-shortcut-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="share-shortcut-label">{label}</span>
    </button>
  );
}

export default function ShareModal({ profile, onClose, onToast }) {
  const { t, lang } = useLang();
  const [link, setLink] = useState(null);
  const [errorCode, setErrorCode] = useState('');

  useEffect(() => {
    let cancelled = false;
    getShareLink()
      .then((payload) => {
        if (!cancelled) setLink(payload);
      })
      .catch((err) => {
        if (!cancelled) setErrorCode(err?.code || 'unknown');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const error = errorCode
    ? errorCode === 'rate_limited'
      ? t('share.rateLimited')
      : t('share.error')
    : '';

  const level = levelFor(profile.record);
  const shareText = link
    ? t('profile.shareText', {
        record: num(profile.record, lang),
        level: t(`level.${level.id}`),
        url: link.url,
      })
    : '';

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      onToast(t('share.copied'));
    } catch {
      onToast(t('share.copyFailed'));
    }
  };

  const nativeShare = () => {
    if (!link) return;
    navigator.share?.({ text: shareText }).catch(() => {});
  };

  const rankLine = link?.rank
    ? t('share.rank', { rank: num(link.rank, lang), tier: link.tier || '' })
    : null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('profile.share')}>
      <div className="modal share-modal">
        <div className="modal-title">{t('profile.share')}</div>
        <div className="share-card">
          <div className="share-card-mark" aria-hidden="true">
            <LogoMark size={32} />
          </div>
          <div className="share-card-title">{t('share.cardTitle')}</div>
          <div className="share-card-record" dir="ltr">
            {num(profile.record, lang)}
          </div>
          <div className="share-card-unit">{t('profile.coins')}</div>
          {rankLine && <div className="share-card-rank">{rankLine}</div>}
        </div>

        {error && <div className="lead-error share-error">{error}</div>}

        <div className="share-url-row">
          <input
            className="share-url-input"
            type="text"
            readOnly
            value={link?.url || ''}
            aria-label={t('share.urlLabel')}
            onFocus={(e) => e.target.select()}
          />
          <button type="button" className="btn-primary share-copy-btn" onClick={copy} disabled={!link}>
            {t('share.copy')}
          </button>
        </div>

        <div className="share-shortcuts">
          <ShareButton
            icon="✈"
            label="Telegram"
            href={link ? `https://t.me/share/url?url=${encodeURIComponent(link.url)}&text=${encodeURIComponent(shareText)}` : null}
          />
          <ShareButton
            icon="✆"
            label="WhatsApp"
            href={link ? `https://wa.me/?text=${encodeURIComponent(shareText)}` : null}
          />
          <ShareButton
            icon="𝕏"
            label="X"
            href={link ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}` : null}
          />
          {navigator.share && (
            <ShareButton icon="⋯" label={t('share.more')} onClick={nativeShare} />
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('share.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
