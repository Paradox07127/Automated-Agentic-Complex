import { useId, useRef, useState, type ReactNode } from 'react';
import { getBridge } from '../../bridge';
import { Btn, Icon, OverlayPortal, reasonOf, useOverlayFocus } from '../../ui';
import styles from './Messages.module.css';

/** The address when it is http or https; null for anything else (javascript:, file:, relative paths). */
export function webUrl(href: string): URL | null {
  if (!/^https?:\/\//i.test(href)) return null;
  try {
    return new URL(href);
  } catch {
    // Not a parseable address: it stays text.
    return null;
  }
}

/** The white paper card before an address leaves the app: the full address with its host marked, 取消 / 复制地址 / 打开. */
export function LinkConfirm({ url, onClose }: { url: URL; onClose: () => void }) {
  return (
    <OverlayPortal>
      <ConfirmBody url={url} onClose={onClose} />
    </OverlayPortal>
  );
}

// Its own component: the focus effect must run after the portal has mounted the panel.
function ConfirmBody({ url, onClose }: { url: URL; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const trap = useOverlayFocus(panel, onClose);
  const titleId = useId();
  const [why, setWhy] = useState<string | null>(null);
  const href = url.href;
  // The host follows the last `@` of the authority; a user name can contain the host's own text.
  const start = href.indexOf('://') + 3;
  const at = start + (href.slice(start).split(/[/?#]/, 1)[0] ?? '').lastIndexOf('@') + 1;
  const failed = (e: unknown) => setWhy(reasonOf(e));
  return (
    <div className={styles.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-theme="light" className={styles.swap} onKeyDown={trap}>
        <h2 id={titleId} className={styles.swapTitle}>打开外部链接？</h2>
        <p className={styles.url} data-selectable="">
          {href.slice(0, at)}
          <b>{url.host}</b>
          {href.slice(at + url.host.length)}
        </p>
        {why && <p role="alert" className={styles.swapWhy}>{why}</p>}
        <div className={styles.swapRow}>
          <Btn variant="secondary" size="sm" onClick={onClose}>取消</Btn>
          <Btn size="sm" onClick={() => void getBridge().clipboard.writeText(href).then(onClose, failed)}>复制地址</Btn>
          <Btn variant="primary" size="sm" onClick={() => void getBridge().open.url(href).then(onClose, failed)}>打开</Btn>
        </div>
      </div>
    </div>
  );
}

/** An address the confirm card guards; the caller has checked it with `webUrl`. */
function useConfirm(href: string) {
  const [open, setOpen] = useState(false);
  const url = webUrl(href);
  const onClick = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    setOpen(true);
  };
  // A middle click would otherwise open the address without the card.
  const onAuxClick = (e: { button: number; preventDefault: () => void }) => {
    if (e.button === 1) onClick(e);
  };
  return { onClick, onAuxClick, card: open && url ? <LinkConfirm url={url} onClose={() => setOpen(false)} /> : null };
}

/** An inline link in a message. */
export function MessageLink({ href, children }: { href: string; children: ReactNode }) {
  const { onClick, onAuxClick, card } = useConfirm(href);
  return (
    <>
      <a href={href} className={styles.link} onClick={onClick} onAuxClick={onAuxClick}>{children}</a>
      {card}
    </>
  );
}

/** A bare address on its own line: host and path only, no fetched title. */
export function LinkCard({ href }: { href: string }) {
  const { onClick, onAuxClick, card } = useConfirm(href);
  const url = webUrl(href)!;
  return (
    <>
      <a href={href} className={styles.lnk} onClick={onClick} onAuxClick={onAuxClick}>
        <span className={styles.fav} aria-hidden="true">{url.hostname.charAt(0).toUpperCase()}</span>
        <span className={styles.lnkText}>
          <b>{url.host}</b>
          <small>{`${url.pathname}${url.search}`}</small>
        </span>
        <Icon name="g-link" size={20} />
      </a>
      {card}
    </>
  );
}

/** A data:, blob: or app-scheme picture; a click opens it large, a failed load leaves a line saying so. */
export function MessageImage({ src, alt }: { src: string; alt: string }) {
  // The address that failed or is open large: another picture in the same place starts fresh.
  const [failed, setFailed] = useState<string | null>(null);
  const [big, setBig] = useState<string | null>(null);
  if (failed === src) return <span className={styles.picFail}>图片没打开</span>;
  return (
    <>
      <button type="button" className={styles.pic} aria-label={`放大图片：${alt || '图片'}`} onClick={() => setBig(src)}>
        <img src={src} alt={alt} onError={() => setFailed(src)} />
      </button>
      {big === src && (
        <OverlayPortal>
          <LightboxBody src={src} alt={alt} onClose={() => setBig(null)} />
        </OverlayPortal>
      )}
    </>
  );
}

/** The picture large over the window; any click or Esc closes it. */
function LightboxBody({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const trap = useOverlayFocus(panel, onClose);
  return (
    <div ref={panel} role="dialog" aria-modal="true" aria-label={alt || '图片'} tabIndex={-1} className={styles.lightbox} onClick={onClose} onKeyDown={trap}>
      <img src={src} alt={alt} />
    </div>
  );
}
