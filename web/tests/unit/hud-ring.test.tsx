import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import type { DesktopAnchor, DesktopState, PointerState, Region, StackPayload } from '../../src/bridge/protocol';
import { stackScenario } from '../../src/mock/stack';
import { NOW } from '../../src/mock/fixtures';
import { RingRoot } from '../../src/surfaces/desktop/RingRoot';
import { above, cardRoom, iconCenters, RING_PANEL, ROW_HEIGHT } from '../../src/surfaces/desktop/ring/geometry';
import { readPresence } from '../../src/surfaces/desktop/tags/presence';
import type { StackCard } from '../../src/surfaces/stack/model';
import { stubMatchMedia } from './mediaStub';

// The icon row under her feet while the pointer is on her.

stubMatchMedia();
document.documentElement.dataset.surface = 'stack';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.location.hash = '';
});

const S = NOW / 1000;
const MIN = 60_000;

describe('ring geometry', () => {
  it('fixes the panel size and the row along its bottom, as native places it', () => {
    expect(RING_PANEL).toEqual({ width: 360, height: 320 });
    expect(ROW_HEIGHT).toBe(36);
  });

  it('lines the icons up in one row centred on her feet, kept in the panel', () => {
    expect(iconCenters(1, 180)).toEqual([{ x: 180, y: 302 }]);
    expect(iconCenters(3, 180)).toEqual([{ x: 140, y: 302 }, { x: 180, y: 302 }, { x: 220, y: 302 }]);
    expect(iconCenters(2, 100).map((p) => p.x)).toEqual([80, 120]);
    // Her feet past the panel's edge: the row stops at it.
    expect(iconCenters(2, -40).map((p) => p.x)).toEqual([20, 60]);
    expect(iconCenters(2, 400).map((p) => p.x)).toEqual([300, 340]);
  });

  it('opens a card or tip above the row, over its icon and inside the panel', () => {
    const [first, second] = iconCenters(2, 180);
    // Its bottom stays `gap` above the row's top (284), clear of every icon.
    expect(cardRoom(10)).toEqual({ width: 260, maxHeight: 284 - 10 - 8 });
    expect(above(second!, 100, 60, 10)).toEqual({ left: 200 - 50, top: 284 - 10 - 60 });
    expect(above(first!, 260, 400, 10)).toEqual({ left: 160 - 130, top: 8 });
    expect(above({ x: 20, y: 302 }, 260, 60, 8)).toEqual({ left: 8, top: 284 - 8 - 60 });
    expect(above({ x: 340, y: 302 }, 260, 60, 8)).toEqual({ left: 360 - 8 - 260, top: 284 - 8 - 60 });
  });
});

const baseState = (extra: Partial<DesktopState> = {}): DesktopState => ({
  hidden: false,
  clickThroughAll: false,
  freeRoam: false,
  quietUntil: null,
  avatarHovered: false,
  character: null,
  characters: [],
  screens: [],
  hotkeys: {},
  pips: { agentd: { state: 'running', pid: 1, backoff: null }, avatar: { state: 'running', pid: 2, backoff: null }, voice: 'on' },
  computerUseActive: false,
  plugins: ['light_ai'],
  ...extra,
});

const reminders = [
  { id: 'c-1', text: '三点和设计组开会', due_at: S + 10 * 60, state: 'armed' },
  { id: 'c-2', text: '给 HostLink 补一条回归测试', due_at: S + 3 * 3600, state: 'armed' },
];

function presence(extra: { reminders?: unknown[]; reminders_more?: number; results?: unknown[]; focus?: unknown } = {}) {
  return {
    sampled_at: S,
    sessions: [],
    additional_sessions: 0,
    pending: { questions: [], approvals: [], tasks: [], results: extra.results ?? [], reminders: extra.reminders ?? [], questions_more: 0, approvals_more: 0, tasks_more: 0, results_more: 0, reminders_more: extra.reminders_more ?? 0, observed_waiting: 0 },
    focus: extra.focus ?? null,
    thought: null,
  };
}

const deliveryCard = stackScenario('delivery').cards.find((c) => c.kind === 'delivery')!;

/** Mounts the ring with anchor, state, presence, cards and pointer pushes under the test's control. */
async function mount(toHead: DesktopAnchor['toHead'] = { dx: 0, dy: -480 }) {
  let pushState: ((s: DesktopState) => void) | undefined;
  let pushPresence: ((raw: unknown) => void) | undefined;
  let pushCards: ((p: StackPayload) => void) | undefined;
  let pointer: ((p: PointerState) => void) | undefined;
  const regions: Region[][] = [];
  const sizes: { width: number; height: number }[] = [];
  const bridge = getBridge();
  vi.spyOn(bridge.window, 'onAnchor').mockImplementation((cb) => {
    queueMicrotask(() => cb({ panel: 'ring', state: 'settled', side: 'below', docked: null, far: false, toHead, room: { width: 456, height: 820 } }));
    return () => {};
  });
  vi.spyOn(bridge.desktop, 'onState').mockImplementation((cb) => {
    pushState = cb;
    return () => {};
  });
  vi.spyOn(bridge.desktop, 'onPresence').mockImplementation((cb) => {
    pushPresence = cb;
    return () => {};
  });
  vi.spyOn(bridge.stack, 'onCards').mockImplementation((cb) => {
    pushCards = cb;
    return () => {};
  });
  vi.spyOn(bridge.window, 'onPointer').mockImplementation((cb) => {
    pointer = cb;
    return () => {};
  });
  vi.spyOn(bridge.window, 'setInteractiveRegions').mockImplementation((r) => void regions.push(r));
  vi.spyOn(bridge.window, 'setContentSize').mockImplementation((s) => void sizes.push(s));
  window.location.hash = '#/ring';
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RingRoot />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(pushState && pushPresence && pushCards && pointer).toBeDefined());
  await act(async () => {});
  return {
    bridge,
    regions,
    sizes,
    push(p: unknown, s: Partial<DesktopState> = {}, cards: StackCard[] = []) {
      act(() => {
        pushCards!({ now: NOW, cards, history: [] });
        pushPresence!(p);
        pushState!(baseState(s));
      });
    },
    state(s: Partial<DesktopState>) {
      act(() => pushState!(baseState(s)));
    },
    pointer(inside: boolean) {
      act(() => pointer!({ x: 10, y: 10, inside }));
    },
  };
}

const root = () => document.querySelector<HTMLElement>('[data-surface-root="ring"]')!;
const icons = () => [...document.querySelectorAll<HTMLElement>('[data-ring-icon]')].map((e) => e.dataset.ringIcon);
const icon = (key: string) => document.querySelector<HTMLElement>(`[data-ring-icon="${key}"]`)!;

describe('ring panel', () => {
  it('reports its fixed size and lines the icons up under her feet', async () => {
    const m = await mount({ dx: -100, dy: -480 });
    await waitFor(() => expect(m.sizes.at(-1)).toEqual({ width: 360, height: 320 }));
    m.push(presence({ reminders }), { avatarHovered: true, quietUntil: NOW + 50 * MIN });
    const at = (key: string) => {
      const s = icon(key).style;
      return [s.left, s.top, s.getPropertyValue('--dx'), s.getPropertyValue('--dy')];
    };
    // Her feet at page x 80: the icons fold on the row's middle there and open 20 px either side of it.
    expect(at('reminders')).toEqual(['65px', '287px', '-20px', '0px']);
    expect(at('quiet')).toEqual(['65px', '287px', '20px', '0px']);
  });

  it('opens while she or the panel is hovered, closes 600 ms after both stop, and stays while a card is open', async () => {
    const m = await mount();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    m.push(presence({ reminders }), { avatarHovered: true });
    expect(root().dataset.open).toBe('true');
    m.state({ avatarHovered: false });
    m.pointer(true);
    act(() => vi.advanceTimersByTime(1000));
    expect(root().dataset.open).toBe('true');
    m.pointer(false);
    act(() => vi.advanceTimersByTime(599));
    expect(root().dataset.open).toBe('true');
    act(() => vi.advanceTimersByTime(1));
    expect(root().dataset.open).toBe('false');

    m.state({ avatarHovered: true });
    fireEvent.click(icon('reminders'));
    expect(document.querySelector('[data-ring-pop="reminders"]')).toBeTruthy();
    m.state({ avatarHovered: false });
    act(() => vi.advanceTimersByTime(5000));
    expect(root().dataset.open).toBe('true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('[data-ring-pop]')).toBeNull();
    act(() => vi.advanceTimersByTime(600));
    expect(root().dataset.open).toBe('false');
  });

  it('reports no region when there is no icon, even while hovered', async () => {
    const m = await mount();
    m.push(presence(), { avatarHovered: true });
    await act(async () => {});
    expect(icons()).toEqual([]);
    expect(m.regions.at(-1) ?? []).toEqual([]);
    m.push(presence({ reminders }), { avatarHovered: true });
    await waitFor(() => expect(m.regions.at(-1)?.length).toBeGreaterThan(0));
  });
});

describe('ring icons', () => {
  it('shows each icon only while its thing is live, in a fixed order', async () => {
    const m = await mount();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    m.push(presence(), { avatarHovered: true, quietUntil: NOW - MIN });
    expect(icons()).toEqual([]);
    m.push(presence({ reminders: [], reminders_more: 0, focus: { until: S + 60, minutes: 25 } }), { avatarHovered: true });
    expect(icons()).toEqual([]);
    m.push(
      presence({ reminders, results: [{ id: 'd-x', generation: 1, revision: 1, title: '周报', since: S, state: 'presented', canonical_task_id: 't-x' }], focus: { until: S + 18 * 60, minutes: 25 } }),
      { avatarHovered: true, quietUntil: NOW + 50 * MIN, clickThroughAll: true },
    );
    expect(icons()).toEqual(['reminders', 'results', 'quiet', 'passthrough']);
    expect(icon('reminders').textContent).toContain('2');
    m.push(presence(), { avatarHovered: true }, [deliveryCard]);
    expect(icons()).toEqual(['results']);
    expect(icon('results').textContent).toContain('1');
  });

  it('hovering an icon says what it holds', async () => {
    const m = await mount();
    m.push(presence({ reminders }), { avatarHovered: true });
    fireEvent.mouseEnter(icon('reminders'));
    expect(document.querySelector('[data-ring-tip]')?.textContent).toBe('2 条提醒，最近：三点和设计组开会');
  });

  it('shows voice trouble and paused observation last; voice off is no icon', async () => {
    const m = await mount();
    const tip = (key: string) => {
      fireEvent.mouseEnter(icon(key));
      const text = document.querySelector('[data-ring-tip]')?.textContent;
      fireEvent.mouseLeave(icon(key));
      return text;
    };
    m.push({ ...presence({ reminders }), voice: { state: 'unreachable', muted: false }, observation: { paused: true } }, { avatarHovered: true });
    expect(icons()).toEqual(['reminders', 'voice', 'observation']);
    expect(tip('voice')).toBe('语音连不上，她先用文字说');
    expect(tip('observation')).toBe('观察已暂停，她现在看不到屏幕');
    m.push({ ...presence(), voice: { state: 'ready', muted: true }, observation: { paused: false } }, { avatarHovered: true });
    expect(icons()).toEqual(['voice']);
    expect(tip('voice')).toBe('语音已静音');
    m.push({ ...presence(), voice: { state: 'off', muted: false }, observation: { paused: false } }, { avatarHovered: true });
    expect(icons()).toEqual([]);
  });

  it('shows 后台 N after results while background runs are active', async () => {
    const m = await mount();
    m.push({ ...presence({ reminders }), role: { state: 'background', background_runs: 2 } }, { avatarHovered: true }, [deliveryCard]);
    expect(icons()).toEqual(['reminders', 'results', 'background']);
    expect(icon('background').getAttribute('aria-label')).toBe('后台 2');
    fireEvent.mouseEnter(icon('background'));
    expect(document.querySelector('[data-ring-tip]')?.textContent).toBe('后台 2');
    m.push({ ...presence(), role: { state: 'idle', background_runs: 0 } }, { avatarHovered: true });
    expect(icons()).toEqual([]);
  });

  it('reads voice and observation from presence; an older agentd without them means no trouble', () => {
    expect(readPresence(presence())).toMatchObject({ voice: null, observation: { paused: false } });
    expect(readPresence({ voice: { state: 'cold', muted: true }, observation: { paused: true } })).toMatchObject({ voice: { state: 'cold', muted: true }, observation: { paused: true } });
  });
});

describe('ring cards', () => {
  it('reminders: 完成 and 稍后 10 分 post to the reminder', async () => {
    const m = await mount();
    const request = vi.spyOn(m.bridge.agentd, 'request').mockResolvedValue({ status: 200, body: { commitment: { due_at: S + 600 } } });
    m.push(presence({ reminders }), { avatarHovered: true });
    fireEvent.click(icon('reminders'));
    const pop = document.querySelector<HTMLElement>('[data-ring-pop="reminders"]')!;
    expect(pop.hasAttribute('data-glass')).toBe(true);
    expect(icon('reminders').hasAttribute('data-glass')).toBe(false);
    const [first, second] = [...pop.querySelectorAll<HTMLElement>('[data-ring-row]')];
    fireEvent.click(within(first!).getByRole('button', { name: '完成' }));
    expect(request).toHaveBeenCalledWith('POST', '/commitments/c-1/complete', undefined);
    fireEvent.click(within(second!).getByRole('button', { name: '稍后 10 分' }));
    expect(request).toHaveBeenCalledWith('POST', '/commitments/c-2/snooze', { minutes: 10 });
  });

  it('results: 打开 opens the task and 不用了 moves the card away', async () => {
    const m = await mount();
    const openMain = vi.spyOn(m.bridge.window, 'openMain').mockImplementation(() => {});
    const collapse = vi.spyOn(m.bridge.stack, 'collapse');
    m.push(presence(), { avatarHovered: true }, [deliveryCard]);
    fireEvent.click(icon('results'));
    const pop = document.querySelector<HTMLElement>('[data-ring-pop="results"]')!;
    fireEvent.click(within(pop).getByRole('button', { name: '打开' }));
    expect(openMain).toHaveBeenCalledWith(expect.stringMatching(/^\/overview\?sel=job%3A/));
    fireEvent.click(within(pop).getByRole('button', { name: '不用了' }));
    expect(collapse).toHaveBeenCalledWith(deliveryCard.id);
    expect(icons()).toEqual([]);
  });

  const notice = (id: string, variant: 'done' | 'brief', extra: { task_id?: `job:${string}` } = {}): StackCard => ({ id, at: NOW, kind: 'notice', variant, title: `${variant} ${id}`, ...extra });
  const resultRow = (title: string) => {
    fireEvent.click(icon('results'));
    const pop = document.querySelector<HTMLElement>('[data-ring-pop="results"]')!;
    return [...pop.querySelectorAll<HTMLElement>('[data-ring-row]')].find((r) => r.textContent?.includes(title))!;
  };

  it('results: 打开 on a 完成 with its task opens and selects that task', async () => {
    const m = await mount();
    const openMain = vi.spyOn(m.bridge.window, 'openMain').mockImplementation(() => {});
    m.push(presence(), { avatarHovered: true }, [notice('n-1', 'done', { task_id: 'job:t9' })]);
    fireEvent.click(within(resultRow('done n-1')).getByRole('button', { name: '打开' }));
    expect(openMain).toHaveBeenCalledWith(expect.stringMatching(/^\/overview\?sel=job%3At9&focus=task-job%3At9/));
  });

  it('results: 打开 on a 简报 opens the 今日简报 on 今天', async () => {
    const m = await mount();
    const openMain = vi.spyOn(m.bridge.window, 'openMain').mockImplementation(() => {});
    m.push(presence(), { avatarHovered: true }, [notice('n-2', 'brief')]);
    fireEvent.click(within(resultRow('brief n-2')).getByRole('button', { name: '打开' }));
    expect(openMain).toHaveBeenCalledWith(expect.stringMatching(/^\/overview\?focus=reminders/));
  });

  it('results: a 完成 with nothing to find it by has no 打开', async () => {
    const m = await mount();
    m.push(presence(), { avatarHovered: true }, [notice('n-3', 'done')]);
    expect(within(resultRow('done n-3')).queryByRole('button', { name: '打开' })).toBeNull();
  });

  it('quiet and pass-through: 结束 ends each one and a refusal leaves a retryable card', async () => {
    const m = await mount();
    const action = vi.spyOn(m.bridge.desktop, 'action').mockRejectedValueOnce({ code: 'unavailable' }).mockResolvedValue();
    m.push(presence(), { avatarHovered: true, quietUntil: NOW + 50 * MIN, clickThroughAll: true });
    fireEvent.click(icon('quiet'));
    const quiet = within(document.querySelector<HTMLElement>('[data-ring-pop="quiet"]')!);
    fireEvent.click(quiet.getByRole('button', { name: '结束' }));
    expect((await quiet.findByRole('status')).textContent).toBe('没能结束免打扰，可以重试');
    fireEvent.click(quiet.getByRole('button', { name: '结束' }));
    expect(action).toHaveBeenCalledWith('quietEnd');
    fireEvent.click(icon('passthrough'));
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-ring-pop="passthrough"]')!).getByRole('button', { name: '结束' }));
    expect(action).toHaveBeenCalledWith('clickThroughAll');
  });

  it('background: 后台 2 lists both runs, and 取消 cancels one until presence drops it', async () => {
    const m = await mount();
    const request = vi.spyOn(m.bridge.agentd, 'request').mockResolvedValue({ status: 202, body: { run_id: 'bg-1', cancellation_requested: true } });
    const runs = [
      { run_id: 'bg-1', generation: 2, title: '汇总会议纪要' },
      { run_id: 'bg-2', generation: 0, title: '整理周报' },
    ];
    m.push({ ...presence(), role: { state: 'background', background_runs: 2, background: runs } }, { avatarHovered: true });
    fireEvent.click(icon('background'));
    const pop = document.querySelector<HTMLElement>('[data-ring-pop="background"]')!;
    const list = within(pop).getByRole('list', { name: '后台运行' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('p')?.textContent)).toEqual(['汇总会议纪要', '整理周报']);
    expect(rows.map((r) => within(r).getByRole('button').getAttribute('aria-label'))).toEqual(['取消汇总会议纪要', '取消整理周报']);
    fireEvent.click(within(rows[0]!).getByRole('button', { name: '取消汇总会议纪要' }));
    expect(request).toHaveBeenCalledWith('POST', '/agent/runs/bg-1/cancel', { generation: 2 });
    await waitFor(() => expect(within(rows[0]!).getByRole('button').textContent).toBe('正在取消'));
    expect(within(rows[0]!).getByRole('button')).toHaveProperty('disabled', true);
    m.push({ ...presence(), role: { state: 'background', background_runs: 1, background: runs.slice(1) } }, { avatarHovered: true });
    expect(within(pop).getAllByRole('listitem').map((r) => r.querySelector('p')?.textContent)).toEqual(['整理周报']);
  });

  it('voice and observation: each card describes the issue and can be dismissed', async () => {
    const m = await mount();
    m.push({ ...presence(), voice: { state: 'unreachable', muted: true }, observation: { paused: true } }, { avatarHovered: true });
    fireEvent.click(icon('voice'));
    const voice = document.querySelector<HTMLElement>('[data-ring-pop="voice"]')!;
    expect(voice.querySelector('h2')?.textContent).toBe('语音');
    expect(voice.querySelector('[data-ring-row]')?.textContent).toBe('语音连不上，她先用文字说');
    expect(within(voice).getAllByRole('button')).toEqual([within(voice).getByRole('button', { name: '关闭语音详情' })]);
    fireEvent.click(within(voice).getByRole('button', { name: '关闭语音详情' }));
    expect(voice.isConnected).toBe(false);
    fireEvent.click(icon('observation'));
    const obs = document.querySelector<HTMLElement>('[data-ring-pop="observation"]')!;
    expect(obs.querySelector('h2')?.textContent).toBe('观察');
    expect(obs.querySelector('[data-ring-row]')?.textContent).toBe('观察已暂停，她现在看不到屏幕');
    expect(within(obs).getAllByRole('button')).toEqual([within(obs).getByRole('button', { name: '关闭观察详情' })]);
  });
});
