import { useEffect, useRef } from 'react';
import { keyText } from '../../bridge/platformText';
import { SETTING_GROUPS } from './groups';
import { usePlugins } from '../../shell/plugins';
import { SearchField, Tabs } from '../../ui';
import { GROUP_ICON, groupShown, isGroup, type GroupId } from './registry';

/** Settings search with ⌘F; it sits in the top bar left of the tabs, or above the content on a narrow page. */
export function SetSearch({ q, onQ }: { q: string; onQ: (q: string) => void }) {
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
  return <SearchField inputRef={input} value={q} placeholder={keyText('搜索设置… ⌘F')} label="搜索设置" onChange={onQ} />;
}

export interface SetNavProps {
  group: GroupId;
  /** Search is showing; no group reads as selected. */
  searching: boolean;
  /** ◆ reason per group (permission missing, kernel not ready). */
  marks: Partial<Record<GroupId, string>>;
  /** Groups holding unapplied drafts. */
  drafts: GroupId[];
  onGroup: (g: GroupId) => void;
}

/** The settings groups as the shared icon tabs, a plug-in's group only while it is on; a cluster starts after a wider gap. */
export function SetNav({ group, searching, marks, drafts, onGroup }: SetNavProps) {
  const plugins = usePlugins();
  const tabs = SETTING_GROUPS.flatMap((cl) =>
    cl.items.filter((it) => isGroup(it.id) && groupShown(it.id, plugins)).map((it, i) => {
      const id = it.id as GroupId;
      return { id, label: it.label, icon: GROUP_ICON[id], mark: marks[id], draft: drafts.includes(id), gap: i === 0 };
    }),
  );
  return <Tabs label="设置分组" keys={false} value={searching ? '' : group} tabs={tabs.map((t, i) => ({ ...t, gap: t.gap && i > 0 }))} onChange={(id) => onGroup(id as GroupId)} />;
}
