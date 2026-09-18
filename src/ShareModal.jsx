import { useEffect, useState } from 'react';
import { levelFor } from './config.js';
import { num, useLang } from './i18n.js';
import { LogoMark } from './Logo.jsx';
import { getShareLink } from './api/socket.js';

function XIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c-.18 1.897-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
    </svg>
  );
}

function ShareButton({ icon, label, href, onClick, disabled }) {
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
    <button type="button" className="share-shortcut" onClick={onClick} aria-label={label} disabled={disabled}>
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
            icon={<XIcon />}
            label={t('share.shareToX')}
            href={link ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}` : null}
          />
          <ShareButton
            icon={<TelegramIcon />}
            label={t('share.shareToTelegram')}
            href={link ? `https://t.me/share/url?url=${encodeURIComponent(link.url)}&text=${encodeURIComponent(shareText)}` : null}
          />
          <ShareButton
            icon={<CopyIcon />}
            label={t('share.copyLink')}
            onClick={copy}
            disabled={!link}
          />
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
