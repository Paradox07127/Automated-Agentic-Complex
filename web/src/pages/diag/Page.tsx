// 诊断: 现在 (NowView) and 回看 (对话轮次, 事件线, 行为决策, 日志) under one set of tabs.
import { useCallback, useEffect } from 'react';
import { Tabs } from '../../ui';
import { useGo, useParam } from '../overview/nav';
import { TraceView } from '../trace/Page';
import { BehaviorView } from './BehaviorView';
import { NowView, TABS, TYPING, type Tab } from './NowView';

const asTab = (v: string | null): Tab | null => TABS.find((t) => t.id === v)?.id ?? null;

export function DiagPage() {
  const go = useGo();
  const item = useParam('item');
  const tab: Tab = asTab(useParam('tab')) ?? (item === 'usage' ? 'flow' : item === 'state' ? 'state' : 'overview');
  const setTab = useCallback((id: Tab) => go({ page: 'diag', ...(id === 'overview' ? {} : { tab: id }) }), [go]);
  const tabs = (marks: Partial<Record<Tab, string>> = {}) => (
    <Tabs label="诊断页签" keys={false} value={tab} tabs={TABS.map((t) => ({ id: t.id, label: t.label, icon: t.icon, mark: marks[t.id], gap: t.id === 'turns' }))} onChange={(id) => setTab(asTab(id) ?? 'overview')} />
  );

  // 1–9 jump to a tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest(TYPING)) return;
      const n = /^[1-9]$/.test(e.key) ? TABS[Number(e.key) - 1] : undefined;
      if (!n) return;
      e.preventDefault();
      setTab(n.id);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setTab]);

  if (tab === 'turns' || tab === 'lanes' || tab === 'logs') return <TraceView tab={tab} tabs={tabs()} />;
  if (tab === 'behavior') return <BehaviorView tabs={tabs()} />;
  return <NowView tab={tab} item={item} onTab={setTab} tabs={tabs} />;
}
