import { useQuery } from '@tanstack/react-query';
import { request } from '../bridge/agentd';
import { appNow } from '../bridge/clock';
import { fromDelivery, fromFact, fromLedgerTask, fromTaskRow, mergeTasks, type Delivery, type Fact, type Task, type WireFact, type WireLedgerTask, type WireTaskRow } from '../domain';
import type { HotkeyLabels } from '../domain/hotkeys';
import { settingPath } from '../pages/settings/groups';
import { stoppable as canStop } from '../pages/tasks/model';
import type { DesktopOp } from './desktopOps';
import { isDevMode } from './devMode';
import type { NavTarget, PageId } from './nav';
import { DEFAULT_PLUGINS, getPlugins, usePlugins, type PluginId, type PluginState } from './plugins';
import { offReason, routeOff } from './registry';
import type { IconName } from '../ui/Icon';
import type { PageRoute } from './types';

/** What ⌘K searches, read through the bridge from the same endpoints the pages use. */
export interface PaletteIndex {
  tasks: Task[];
  deliveries: Delivery[];
  facts: Fact[];
  /** Paths that did not answer 200, so the search says what it could not look in. */
  missing: string[];
}

async function read<T>(path: string, missing: string[]): Promise<T | null> {
  const res = await request<T>('GET', path);
  if (res.status === 200 && res.body) return res.body;
  missing.push(path);
  return null;
}

export async function loadPaletteIndex(): Promise<PaletteIndex> {
  const missing: string[] = [];
  // Tasks exist only with 个人代理 on.
  const agent = getPlugins().personal_agent;
  const [role, other, memory] = await Promise.all([
    agent ? read<{ tasks: WireTaskRow[] }>('/agent/tasks', missing) : null,
    agent ? read<{ tasks: WireLedgerTask[] }>('/tasks', missing) : null,
    read<{ facts: WireFact[] }>('/memory', missing),
  ]);
  const rows = role?.tasks ?? [];
  const ledger = other?.tasks ?? [];
  return {
    tasks: mergeTasks(
      rows.map((r) => fromTaskRow(r, ledger.find((l) => l.task_id === r.task_id))),
      ledger.map(fromLedgerTask),
    ),
    deliveries: rows.flatMap((r) => (r.delivery ? [fromDelivery(r.delivery)] : [])),
    facts: (memory?.facts ?? []).map((f) => fromFact(f, appNow())),
    missing,
  };
}

export function usePaletteIndex() {
  return useQuery({ queryKey: ['cmd-palette', usePlugins().personal_agent], queryFn: loadPaletteIndex, retry: false, staleTime: 30_000 });
}

export type PaletteGroup = '跳页' | '搜索' | '动作';

export type PaletteRun =
  | { kind: 'nav'; target: NavTarget }
  | { kind: 'stop'; task: Task }
  | { kind: 'desktop'; op: DesktopOp }
  /** Needs a native op this shell does not have, or a plug-in that is off: shown disabled with the reason, sends nothing. */
  | { kind: 'off'; reason: string }
  | { kind: 'quiet' }
  | { kind: 'recheck' };

export interface PaletteItem {
  key: string;
  group: PaletteGroup;
  label: string;
  /** Pages: the page's icon before the label. */
  icon?: IconName;
  /** What the item is or does; empty for pages. */
  hint: string;
  /** Key chord shown as a key cap. */
  shortcut?: string;
  run: PaletteRun;
}

const MAX_HITS = 5;

/** The task page's rule, without own sessions (the index has none); a task stops through its job, its character ledger row or its run. */
const stoppable = (t: Task) =>
  canStop(t, { sessions: [] }) && (t.id.startsWith('job:') || (t.target === 'character' && t.task_id != null) || t.run_id != null);

const desktop = (op: DesktopOp, hint: string, off: Partial<Record<DesktopOp, string>>) => {
  const reason = off[op];
  return reason ? { hint: reason, run: { kind: 'off' as const, reason } } : { hint, run: { kind: 'desktop' as const, op } };
};

/** An action whose plug-in is off: listed, disabled with its 已关闭 reason. */
const closed = (id: PluginId) => ({ hint: offReason(id), run: { kind: 'off' as const, reason: offReason(id) } });

/** Items in display order: pages, then search hits (only with a query), then actions; `off` says which desktop ops this shell lacks, `keys` the saved hotkeys, `plugins` which pages and actions are 已关闭. */
export function paletteItems(
  query: string,
  routes: PageRoute[],
  index: PaletteIndex | undefined,
  off: Partial<Record<DesktopOp, string>> = {},
  keys: HotkeyLabels = {},
  plugins: PluginState = DEFAULT_PLUGINS,
): PaletteItem[] {
  const q = query.trim().toLowerCase();
  const has = (text: string) => !q || text.toLowerCase().includes(q);
  const pages: PaletteItem[] = routes
    .filter((r) => r.nav !== false && (!r.devOnly || isDevMode()) && has(`${r.title} ${r.en} ${r.id}`))
    .map((r) => ({ key: `page-${r.id}`, group: '跳页', label: r.title, ...(r.icon ? { icon: r.icon } : {}), hint: routeOff(r, plugins) ? '已关闭' : '', shortcut: r.hotkey, run: { kind: 'nav', target: { page: r.id as PageId } } }));
  const actions: PaletteItem[] = [
    { key: 'quick-input', group: '动作' as const, label: '快速输入', shortcut: keys.hk_quick, words: 'input quick 输入 桌面', ...desktop('quickInput', '桌面上的输入框', off) },
    { key: 'look', group: '动作' as const, label: '屏幕识读', shortcut: keys.hk_look, words: 'look observe 屏幕 识读', ...(plugins.screen_reading ? desktop('look', '识读前台窗口', off) : closed('screen_reading')) },
    { key: 'quiet', group: '动作' as const, label: '免打扰 30 分钟', hint: '提醒暂停，到点自动恢复', words: 'quiet dnd 安静 勿扰', run: { kind: 'quiet' as const } },
    { key: 'recheck', group: '动作' as const, label: '重新检测内核', words: 'kernel runtime recheck 运行时', ...(plugins.harness_bridge ? { hint: settingPath('kernel'), run: { kind: 'recheck' as const } } : closed('harness_bridge')) },
    ...(index?.tasks ?? []).filter(stoppable).map((t) => ({
      key: `stop-${t.id}`,
      group: '动作' as const,
      label: `停止任务 │ ${t.title}`,
      hint: '需确认',
      words: 'stop 取消',
      run: { kind: 'stop' as const, task: t },
    })),
    // After the task stops, so 「停止」 still lands on a task first.
    { key: 'stop-speech', group: '动作' as const, label: '停止说话', words: 'stop speech mute 别说了 闭嘴', ...desktop('stopSpeech', '打断角色正在说的这句', off) },
  ]
    .filter((a) => has(`${a.label} ${a.words}`))
    .map(({ words: _words, ...a }) => a);
  if (!q || !index) return [...pages, ...actions];
  const taskTitle = (id: string) => index.tasks.find((t) => t.id === id)?.title ?? id;
  const tasks: PaletteItem[] = index.tasks
    .filter((t) => has(t.title))
    .slice(0, MAX_HITS)
    .map((t) => ({ key: `task-${t.id}`, group: '搜索', label: t.title, hint: '任务', run: { kind: 'nav', target: { page: 'overview', sel: t.id } } }));
  const facts: PaletteItem[] = index.facts
    .filter((f) => has(f.text))
    .slice(0, MAX_HITS)
    .map((f) => ({ key: `fact-${f.id}`, group: '搜索', label: f.text, hint: '记忆', run: { kind: 'nav', target: { page: 'memory', view: 'about', sel: f.id } } }));
  const deliveries: PaletteItem[] = index.deliveries
    .filter((d) => has(`${taskTitle(d.task_id)} ${d.artifacts.map((a) => a.name).join(' ')}`))
    .slice(0, MAX_HITS)
    .map((d) => ({
      key: `dlv-${d.id}`,
      group: '搜索',
      label: `${taskTitle(d.task_id)} v${d.version}`,
      hint: `交付 │ ${d.artifacts.length} 个产物`,
      run: { kind: 'nav', target: { page: 'overview', sel: d.task_id } },
    }));
  return [...pages, ...tasks, ...facts, ...deliveries, ...actions];
}
