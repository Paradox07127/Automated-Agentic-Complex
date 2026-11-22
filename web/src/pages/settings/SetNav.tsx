import { useEffect, useRef } from 'react';
import { keyText } from '../../bridge/platformText';
import { Icon, Tabs } from '../../ui';
import { SETTING_GROUPS } from './groups';
import { GROUP_ICON, type GroupId } from './registry';
import styles from './SetNav.module.css';

/** Settings search (⌘F) in the top bar: a white capsule; Enter opens the first result. On the smallest window it folds to a round button until focused. */
export function SetSearch({ q, onQ, onEnter }: { q: string; onQ: (q: string) => void; onEnter: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <label className={styles.search} data-q={q ? '' : undefined}>
      <Icon name="search" size={16} />
      <input
        ref={input}
        type="text"
        value={q}
        placeholder="搜索设置"
        aria-label="搜索设置"
        onChange={(e) => onQ(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter();
          else if (e.key === 'Escape' && q) {
            e.preventDefault();
            e.stopPropagation();
            onQ('');
          }
        }}
      />
      <kbd className={styles.kbd} aria-hidden="true">
        {keyText('⌘F')}
      </kbd>
    </label>
  );
}

export interface SetNavProps {
  group: GroupId;
  /** Search is showing; no group reads as selected. */
  searching: boolean;
  /** ◆ reason per group (voice down, permission missing, kernel not ready). */
  marks: Partial<Record<GroupId, string>>;
  /** Groups holding unapplied drafts. */
  drafts: GroupId[];
  onGroup: (g: GroupId) => void;
}

/** The eight groups as the shared icon tabs. */
export function SetNav({ group, searching, marks, drafts, onGroup }: SetNavProps) {
  const tabs = SETTING_GROUPS.map((g) => ({ id: g.id, label: g.label, icon: GROUP_ICON[g.id], mark: marks[g.id], draft: drafts.includes(g.id) }));
  return <Tabs label="设置分组" keys={false} value={searching ? '' : group} tabs={tabs} onChange={(id) => onGroup(id as GroupId)} />;
}
