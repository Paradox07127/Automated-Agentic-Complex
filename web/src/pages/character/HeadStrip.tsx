import { useEffect, useRef, useState, type Ref } from 'react';
import type { CharacterEntry } from '../../bridge';
import type { CharacterProfile } from '../../domain';
import { CharacterArt, Icon } from '../../ui';
import { HeadPick } from './charMotion';
import { Roster } from './Roster';
import styles from './HeadStrip.module.css';

export interface HeadStripProps {
  roster: CharacterEntry[];
  current: string;
  /** Target of a switch in progress. */
  pending: string | null;
  offline: boolean;
  importing: boolean;
  onPick: (c: CharacterProfile) => void;
  /** Absent when the shell cannot import packages. */
  onImport?: (() => void) | undefined;
  bare: boolean;
  onBare: (bare: boolean) => void;
  /** The heads, for charlistnode_in. */
  listRef?: Ref<HTMLDivElement>;
}

/** 左边的头像条：点头像直接换人；底部是名册（全部角色和导入）、隐藏界面。 */
export function HeadStrip(p: HeadStripProps) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !boxRef.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const cur = p.roster.find((c) => c.id === p.current);
  return (
    <div className={styles.strip} data-g="listSide" data-bare={p.bare || undefined}>
      <div ref={p.listRef} className={styles.heads} role="group" aria-label="角色头像">
        {p.roster.map((c) => {
          const on = c.id === p.current;
          return (
            <button
              key={c.id}
              type="button"
              className={styles.head}
              data-g="root"
              aria-label={c.name}
              aria-current={on ? 'true' : undefined}
              data-target={p.pending === c.id || undefined}
              disabled={p.pending != null || ((p.offline || p.importing) && !on)}
              title={p.pending != null ? '正在切换' : on ? `${c.name} │ 当前` : p.offline ? '角色未运行' : p.importing ? '导入中' : `切换到 ${c.name}`}
              onClick={() => !on && p.onPick(c)}
            >
              {on && <HeadPick />}
              <span className={styles.face}>
                <CharacterArt src={c.head} id={c.id} art="round" kind="head" w={60} h={60} fallback={<Icon name="user" size={24} />} />
              </span>
            </button>
          );
        })}
      </div>
      <div ref={boxRef} className={styles.keys}>
        <button type="button" className={styles.key} aria-expanded={open} aria-label={`切换角色，当前 ${cur?.name ?? ''}`} title="全部角色" onClick={() => setOpen((v) => !v)}>
          <Icon name="menu" size={20} />
        </button>
        <button type="button" className={styles.key} data-bare-key="" aria-pressed={p.bare} aria-label="隐藏界面" title={p.bare ? '显示界面' : '隐藏界面'} onClick={() => (setOpen(false), p.onBare(!p.bare))}>
          <Icon name="side" size={20} />
        </button>
        {open && (
          <div className={styles.pop} role="dialog" aria-label="全部角色">
            <Roster
              characters={p.roster}
              current={p.current}
              pending={p.pending}
              offline={p.offline}
              importing={p.importing}
              onPick={(c) => (setOpen(false), c.id !== p.current && p.onPick(c))}
              {...(p.onImport ? { onImport: () => (setOpen(false), p.onImport?.()) } : {})}
            />
          </div>
        )}
      </div>
    </div>
  );
}
