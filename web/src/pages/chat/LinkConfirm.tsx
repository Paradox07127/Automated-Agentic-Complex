import { useId, useRef, useState, type ReactNode } from 'react';
import { getBridge } from '../../bridge';
import { Btn, Icon, OverlayPortal, useOverlayFocus } from '../../ui';
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
  const panel = useRef<HTMLDivElement>(null);
  const trap = useOverlayFocus(panel, onClose);
  const titleId = useId();
  const href = url.href;
  const at = href.indexOf(url.host, url.protocol.length + 2);
  return (
    <OverlayPortal>
      <div className={styles.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-theme="light" className={styles.swap} onKeyDown={trap}>
          <h2 id={titleId} className={styles.swapTitle}>打开外部链接？</h2>
          <p className={styles.url} data-selectable="">
            {href.slice(0, at)}
            <b>{url.host}</b>
            {href.slice(at + url.host.length)}
          </p>
          <div className={styles.swapRow}>
            <Btn variant="secondary" size="sm" onClick={onClose}>取消</Btn>
            <Btn size="sm" onClick={() => void getBridge().clipboard.writeText(href).then(onClose)}>复制地址</Btn>
            <Btn variant="primary" size="sm" onClick={() => { void getBridge().open.url(href); onClose(); }}>打开</Btn>
          </div>
        </div>
      </div>
    </OverlayPortal>
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
  return { onClick, card: open && url ? <LinkConfirm url={url} onClose={() => setOpen(false)} /> : null };
}

/** An inline link in a message. */
export function MessageLink({ href, children }: { href: string; children: ReactNode }) {
  const { onClick, card } = useConfirm(href);
  return (
    <>
      <a href={href} className={styles.link} onClick={onClick}>{children}</a>
      {card}
    </>
  );
}

/** A bare address on its own line: host and path only, no fetched title. */
export function LinkCard({ href }: { href: string }) {
  const { onClick, card } = useConfirm(href);
  const url = webUrl(href)!;
  return (
    <>
      <a href={href} className={styles.lnk} onClick={onClick}>
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

/** A picture from any http(s) or data:image address; a click opens it large, a failed load leaves a line with its address. */
export function MessageImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const [big, setBig] = useState(false);
  const web = webUrl(src);
  if (failed)
    return (
      <span className={styles.picFail}>
        图片没打开
        {web && (
          <>
            {' │ '}
            <MessageLink href={src}>打开链接</MessageLink>
          </>
        )}
      </span>
    );
  return (
    <>
      <button type="button" className={styles.pic} aria-label={`放大图片：${alt || '图片'}`} onClick={() => setBig(true)}>
        <img src={src} alt={alt} onError={() => setFailed(true)} />
      </button>
      {big && <Lightbox src={src} alt={alt} onClose={() => setBig(false)} />}
    </>
  );
}

/** The picture large over the window; any click or Esc closes it. */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const trap = useOverlayFocus(panel, onClose);
  return (
    <OverlayPortal>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={alt || '图片'} tabIndex={-1} className={styles.lightbox} onClick={onClose} onKeyDown={trap}>
        <img src={src} alt={alt} />
      </div>
    </OverlayPortal>
  );
}
