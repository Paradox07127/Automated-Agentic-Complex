import { useEffect, useState } from 'react';
import { ContextMenu, type MenuItem } from '../../ui';
import type { ChatCharacter } from './useChatData';
import styles from './CharTabs.module.css';

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** Her head art in a round face, else a drawn head-and-shoulders. */
export function Face({ c }: { c: ChatCharacter | undefined }) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = c?.head;
  return (
    <span className={styles.face} aria-hidden="true">
      {src && failed !== src ? <img src={src} alt="" onError={() => setFailed(src)} /> : <i className={styles.generic} />}
    </span>
  );
}

export interface CharTabsProps {
  chars: ChatCharacter[];
  selected: string | null;
  /** The character on the desktop (`/state`). */
  present: string | null;
  onPick: (id: string) => void;
  menuFor: (c: ChatCharacter) => MenuItem[];
}

/** One tab per character in the header, the selected one a yellow block, a green dot on the one on the desktop; Q / E step through them. */
export function CharTabs({ chars, selected, present, onPick, menuFor }: CharTabsProps) {
  const [ctx, setCtx] = useState<{ id: string; at: { x: number; y: number } } | null>(null);
  const [shownFor, setShownFor] = useState(selected);
  if (shownFor !== selected) {
    setShownFor(selected);
    setCtx(null);
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
      const k = e.key.toLowerCase();
      if (k !== 'q' && k !== 'e') return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest(EDITABLE) || (t as HTMLElement | null)?.isContentEditable) return;
      if (document.querySelector('[role="dialog"], [aria-modal="true"], [role="menu"]')) return;
      const at = chars.findIndex((c) => c.id === selected);
      const next = chars[(at + (k === 'e' ? 1 : chars.length - 1)) % chars.length];
      if (at < 0 || !next) return;
      // The shell's command bar steps page tabs on the same keys; this one is handled.
      e.preventDefault();
      onPick(next.id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [chars, selected, onPick]);
  const open = chars.find((c) => c.id === ctx?.id);
  return (
    <div className={styles.tabs} role="tablist" aria-label="角色">
      {chars.map((c) => {
        const desk = c.id === present;
        return (
          <button
            key={c.id}
            type="button"
            role="tab"
            className={styles.tab}
            aria-selected={c.id === selected}
            aria-label={desk ? `${c.name}，在桌面` : c.name}
            title={c.name}
            onClick={() => onPick(c.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtx({ id: c.id, at: { x: e.clientX, y: e.clientY } });
            }}
          >
            <span className={styles.ava}>
              <Face c={c} />
              {desk && <span className={styles.desk} />}
            </span>
            <span className={styles.name}>{c.name}</span>
          </button>
        );
      })}
      <ContextMenu label={open?.name ?? ''} items={open ? menuFor(open) : []} at={open ? (ctx?.at ?? null) : null} onClose={() => setCtx(null)} />
    </div>
  );
}
