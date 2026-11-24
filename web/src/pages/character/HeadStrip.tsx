import { useEffect, useRef, useState, type Ref } from 'react';
import type { CharacterEntry } from '../../bridge';
import type { CharacterProfile } from '../../domain';
import { CharacterArt, Icon } from '../../ui';
import { MicroLabel } from '../../ui/game';
import { HeadPick } from './charMotion';
import { DeskGlyph } from './NameBlock';
import { pad2, Roster } from './Roster';
import styles from './HeadStrip.module.css';
import pop from './RosterPop.module.css';

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

/** 左边的头像条（只在总览）：点头像直接换人，桌面上那位左上蓝标；左下是名册三角键（全部角色和导入）和「只看模型」。 */
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
                <CharacterArt src={c.head} kind="head" w={60} h={60} fallback={<Icon name="user" size={24} />} />
              </span>
              {c.active && (
                <span className={styles.desk} aria-hidden="true">
                  <DeskGlyph />
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div ref={boxRef} className={styles.keys} data-g="bottomMenu">
        <button type="button" className={styles.list} aria-expanded={open} aria-label={`切换角色，当前 ${cur?.name ?? ''}`} title="全部角色" onClick={() => setOpen((v) => !v)}>
          <Icon name="grid" size={20} />
          <MicroLabel>Roster</MicroLabel>
        </button>
        <button type="button" className={styles.bareKey} data-bare-key="" aria-pressed={p.bare} aria-label="隐藏界面" title={p.bare ? '显示界面' : '隐藏界面，只看模型'} onClick={() => (setOpen(false), p.onBare(!p.bare))}>
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true" focusable="false">
            <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
            <circle cx="12" cy="12" r="3" />
            <path d="M4 20 20 4" />
          </svg>
          <span className={styles.lbl}>只看模型</span>
        </button>
        {open && (
          <div className={pop.pop} role="dialog" aria-label="全部角色">
            <div className={pop.popHd}>
              全部角色
              <span className={pop.popN} aria-hidden="true">
                {pad2(p.roster.length)}
              </span>
            </div>
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
