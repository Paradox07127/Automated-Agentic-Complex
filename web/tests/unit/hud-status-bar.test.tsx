import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import type { DesktopCommand, Region, StackPayload } from '../../src/bridge/protocol';
import { stackScenario } from '../../src/mock/stack';
import { NOW } from '../../src/mock/fixtures';
import { A2, Q1 } from '../../src/mock/fixtures/ids';
import { HudRoot } from '../../src/surfaces/desktop/HudRoot';
import { HUD_DONE_MS, hudRows } from '../../src/surfaces/desktop/hud/rows';
import { nextPresence, readPresence } from '../../src/surfaces/desktop/tags/presence';
import type { StackCard } from '../../src/surfaces/stack/model';
import { stubMatchMedia } from './mediaStub';

// The session status bar under her, one line per live session and per standalone card that waits on you.

stubMatchMedia();
document.documentElement.dataset.surface = 'stack';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.location.hash = '';
});

const S = NOW / 1000;

/** A presence `sessions[]` row as agentd sends it (epoch seconds). */
function wireRow(id: string, extra: Record<string, unknown> = {}) {
  return { id, backend: 'claude', title: `会话 ${id}`, state: 'running', updated_at: S - 120, tool: null, target: null, approvals: [], status: 'running', activity: '执行工具', ...extra };
}

const pick = (scenario: string, test: (c: StackCard) => boolean): StackCard => {
  const c = stackScenario(scenario).cards.find(test);
  if (!c) throw new Error(`no card in ${scenario}`);
  return c;
};
const approval = pick('default', (c) => c.id === A2);
const question = pick('question', (c) => c.id === Q1) as Extract<StackCard, { kind: 'question' }>;
const errorCard = pick('task-error', (c) => c.kind === 'error');
const lookCard = pick('task-error', (c) => c.kind === 'notice');
const deliveryCard = pick('delivery', (c) => c.kind === 'delivery');
const reminderCard = pick('delivery', (c) => c.kind === 'notice');
const reviewCard = pick('review', (c) => c.kind === 'review');
const loadingCard = pick('desktop-progress', (c) => c.kind === 'notice' && c.variant === 'loading');
const notices = stackScenario('notices').cards;
const dropCard: StackCard = { id: 'drop-1', kind: 'notice', variant: 'drop', at: NOW, title: '拖入 1 个文件', items: [{ kind: 'file', path: '/tmp/a.txt', name: 'a.txt', handle: 'H:a.txt' }], truncated: false };

/** Mounts the bar with the pushes, commands and region reports under the test's control. */
async function mount(hash = '#/hud') {
  let pushCards: ((p: StackPayload) => void) | undefined;
  let pushPresence: ((raw: unknown) => void) | undefined;
  let command: ((c: DesktopCommand) => void) | undefined;
  const regions: Region[][] = [];
  const bridge = getBridge();
  vi.spyOn(bridge.stack, 'onCards').mockImplementation((cb) => {
    pushCards = cb;
    return () => {};
  });
  vi.spyOn(bridge.desktop, 'onPresence').mockImplementation((cb) => {
    pushPresence = cb;
    return () => {};
  });
  vi.spyOn(bridge.desktop, 'onCommand').mockImplementation((cb) => {
    command = cb;
    return () => {};
  });
  vi.spyOn(bridge.window, 'setInteractiveRegions').mockImplementation((r) => void regions.push(r));
  window.location.hash = hash;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <HudRoot />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(pushCards && pushPresence && command).toBeDefined());
  return {
    ...view,
    bridge,
    regions,
    push(cards: StackCard[], sessions: unknown[], now = NOW) {
      act(() => {
        pushPresence!({ sampled_at: S, sessions, additional_sessions: 0, thought: null });
        pushCards!({ now, cards, history: [] });
      });
    },
    command(c: DesktopCommand) {
      act(() => command!(c));
    },
    presence(raw: unknown) {
      act(() => pushPresence!(raw));
    },
    payload(p: StackPayload) {
      act(() => pushCards!(p));
    },
  };
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-hud-row]')];
const ids = () => rows().map((r) => r.dataset.hudRow);
const bar = () => document.querySelector<HTMLElement>('[data-hud-bar]')!;
const expand = () => fireEvent.click(bar());

describe('status bar rows', () => {
  it('lists the live sessions and the standalone cards that wait on you; notices, reminders, drops and loading stay out', async () => {
    const m = await mount();
    m.push([approval, errorCard, deliveryCard, reminderCard, reviewCard, lookCard, loadingCard, dropCard, ...notices], [wireRow('s-run')]);
    await waitFor(() => expect(rows().length).toBe(1));
    expand();
    expect(ids().sort()).toEqual([A2, errorCard.id, deliveryCard.id, reviewCard.id, 's-run'].sort());
  });

  it('a delivery and a review wait on you; expanded the review accepts and rejects, the delivery opens its task', async () => {
    const m = await mount();
    const decide = vi.spyOn(m.bridge.stack, 'decide').mockResolvedValue();
    const openMain = vi.spyOn(m.bridge.window, 'openMain').mockImplementation(() => {});
    m.push([deliveryCard, reviewCard], [wireRow('s-run')]);
    await waitFor(() => expect(rows().length).toBe(1));
    expect(within(bar()).getByRole('button', { name: '处理' })).toBeTruthy();
    expand();
    const line = (id: string) => rows().find((r) => r.dataset.hudRow === id)!;
    expect(line(deliveryCard.id).dataset.status).toBe('waiting');
    expect(line(reviewCard.id).dataset.status).toBe('waiting');
    const review = line(reviewCard.id).querySelector<HTMLElement>(`[data-card-id="${reviewCard.id}"]`)!;
    expect(document.body.textContent).not.toMatch(/REVIEW|Delivery/);
    fireEvent.click(within(review).getByRole('button', { name: '接受当前版本' }));
    expect(decide).toHaveBeenCalledWith(reviewCard.id, expect.objectContaining({ kind: 'accept' }));
    fireEvent.click(within(review).getByRole('button', { name: '驳回当前版本' }));
    expect(within(review).getByRole('button', { name: '驳回并继续' })).toBeTruthy();
    const delivery = line(deliveryCard.id).querySelector<HTMLElement>(`[data-card-id="${deliveryCard.id}"]`)!;
    fireEvent.click(within(delivery).getByRole('button', { name: '看结果' }));
    expect(openMain).toHaveBeenCalled();
  });

  it('sorts waiting, then error, then running, then done', async () => {
    const m = await mount();
    m.push([], [
      wireRow('s-done', { status: 'done', state: 'done', updated_at: S }),
      wireRow('s-run'),
      wireRow('s-err', { status: 'error', state: 'error' }),
      wireRow('s-wait', { status: 'needs_you', state: 'awaiting_approval' }),
    ]);
    await waitFor(() => expect(rows().length).toBe(1));
    expect(ids()).toEqual(['s-wait']);
    expand();
    expect(ids()).toEqual(['s-wait', 's-err', 's-run', 's-done']);
    expect(rows().map((r) => r.dataset.status)).toEqual(['waiting', 'error', 'running', 'done']);
  });

  it('puts an approval card above a question card that runs out sooner', async () => {
    const m = await mount();
    const soon = { ...question, item: { ...question.item, seconds_left: 5 } } as StackCard;
    m.push([soon, approval], [wireRow('s-run')]);
    await waitFor(() => expect(rows().length).toBe(1));
    expand();
    expect(ids()).toEqual([A2, Q1, 's-run']);
  });

  it('puts a session awaiting approval above one awaiting an answer', async () => {
    const m = await mount();
    m.push([], [wireRow('s-input', { status: 'needs_you', state: 'awaiting_input' }), wireRow('s-approve', { status: 'needs_you', state: 'awaiting_approval' })]);
    await waitFor(() => expect(rows().length).toBe(1));
    expand();
    expect(ids()).toEqual(['s-approve', 's-input']);
  });

  it('a stale session is a grey line after running and done that opens its session', async () => {
    const m = await mount();
    const jump = vi.spyOn(m.bridge.open, 'jumpToSession').mockResolvedValue();
    const request = vi.spyOn(m.bridge.agentd, 'request').mockResolvedValue({ status: 200, body: { seen: true } });
    m.push([], [
      wireRow('s-stale', { status: 'stale', state: 'stale', doing: '3 分钟没动静', activity: '无更新', updated_at: S - 180 }),
      wireRow('s-done', { status: 'done', state: 'done', updated_at: S }),
      wireRow('s-run'),
    ]);
    await waitFor(() => expect(rows().length).toBe(1));
    expand();
    expect(ids()).toEqual(['s-run', 's-done', 's-stale']);
    const stale = rows()[2]!;
    expect(stale.dataset.status).toBe('stale');
    expect(stale.querySelector('[data-hud-act]')?.textContent).toBe('│ 3 分钟没动静');
    fireEvent.click(within(stale).getByRole('button', { name: '会话 s-stale' }));
    expect(jump).toHaveBeenCalledWith('s-stale');
    await waitFor(() => expect(request).toHaveBeenCalledWith('POST', '/desktop/sessions/seen', { session_id: 's-stale' }));
  });
});

describe('toasts', () => {
  it('a notice set while the one before it plays out or lingers still shows', async () => {
    const m = await mount();
    vi.spyOn(m.bridge.open, 'jumpToSession').mockResolvedValue();
    vi.spyOn(m.bridge.agentd, 'request').mockResolvedValue({ status: 200, body: { seen: true } });
    m.push([], [wireRow('s-a'), wireRow('s-b')]);
    await waitFor(() => expect(rows().length).toBe(1));
    expand();
    vi.useFakeTimers();
    const open = async (id: string) => {
      fireEvent.click(within(rows().find((r) => r.dataset.hudRow === id)!).getByRole('button', { name: `会话 ${id}` }));
      await act(async () => {});
    };
    await open('s-a');
    expect(document.querySelector('[data-hud-toast]')?.textContent).toContain('已打开会话：会话 s-a');
    act(() => vi.advanceTimersByTime(2700));
    await open('s-b');
    expect(document.querySelector('[data-hud-toast]')?.textContent).toContain('已打开会话：会话 s-b');
    // One set while the one before it plays its exit outlasts that exit.
    act(() => vi.advanceTimersByTime(2550));
    await open('s-a');
    act(() => vi.advanceTimersByTime(300));
    expect(document.querySelector('[data-hud-toast]')?.textContent).toContain('已打开会话：会话 s-a');
  });
});

describe('folded and expanded', () => {
  it('folded shows only the top line, two edges, the total and 处理 when the top one waits', async () => {
    const m = await mount();
    m.push([], [wireRow('s-run'), wireRow('s-err', { status: 'error' }), wireRow('s-wait', { status: 'needs_you' }), wireRow('s-run2')]);
    await waitFor(() => expect(rows().length).toBe(1));
    expect(bar().querySelectorAll('[data-edge]').length).toBe(2);
    expect(bar().querySelector('[data-hud-count]')?.textContent).toBe('4');
    expect(within(bar()).getByRole('button', { name: '处理' })).toBeTruthy();
    expect(bar().querySelector('[data-hud-meta]')).toBeNull();
  });

  it('has no 处理 when the top line does not wait', async () => {
    const m = await mount();
    m.push([], [wireRow('s-run'), wireRow('s-err', { status: 'error' })]);
    await waitFor(() => expect(rows().length).toBe(1));
    expect(within(bar()).queryByRole('button', { name: '处理' })).toBeNull();
    expect(bar().querySelectorAll('[data-edge]').length).toBe(1);
  });

  it('expanded answers the approval inside its session line', async () => {
    const m = await mount();
    const decide = vi.spyOn(m.bridge.stack, 'decide');
    m.push([approval], [wireRow('s-run'), wireRow('s-wait', { status: 'needs_you', approvals: [A2] })]);
    await waitFor(() => expect(rows().length).toBe(1));
    expect(document.querySelector(`[data-card-id="${A2}"]`)).toBeNull();
    expand();
    const line = rows()[0]!;
    expect(line.dataset.hudRow).toBe('s-wait');
    const inline = line.querySelector<HTMLElement>(`[data-card-id="${A2}"]`);
    expect(inline).toBeTruthy();
    fireEvent.click(within(inline!).getByRole('button', { name: '批准' }));
    expect(decide).toHaveBeenCalledWith(A2, expect.objectContaining({ kind: 'approval', verdict: 'allow' }));
  });

  it('a standalone approval gets its own line with the card inside it', async () => {
    const m = await mount();
    m.push([approval], [wireRow('s-run')]);
    await waitFor(() => expect(rows().length).toBe(1));
    expect(ids()).toEqual([A2]);
    expand();
    expect(rows()[0]!.querySelector(`[data-card-id="${A2}"]`)).toBeTruthy();
  });

  it('a collapsed standalone card has no line', async () => {
    const m = await mount();
    m.push([{ ...approval, collapsed: true }, errorCard], [wireRow('s-run')]);
    await waitFor(() => expect(rows().length).toBe(1));
    expand();
    expect(ids().sort()).toEqual([errorCard.id, 's-run'].sort());
  });

  it('a collapsed approval a session claims leaves the session line, which still waits', () => {
    const presence = { sampled_at: S, sessions: [wireRow('s-run', { approvals: [A2] })], additional_sessions: 0, thought: null };
    const [row, ...rest] = hudRows([{ ...approval, collapsed: true }], presence, NOW);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ id: 's-run', status: 'waiting', cards: [] });
  });

  it('收起 and Escape fold it back; a title opens its session', async () => {
    const m = await mount();
    const jump = vi.spyOn(m.bridge.open, 'jumpToSession').mockResolvedValue();
    m.push([], [wireRow('s-run', { title: '修 HostLink' }), wireRow('s-err', { status: 'error' })]);
    await waitFor(() => expect(rows().length).toBe(1));
    expand();
    expect(rows().length).toBe(2);
    fireEvent.click(within(rows()[1]!).getByRole('button', { name: /修 HostLink/ }));
    expect(jump).toHaveBeenCalledWith('s-run');
    fireEvent.click(document.querySelector('[data-hud-fold]')!);
    expect(rows().length).toBe(1);
    expand();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(rows().length).toBe(1);
  });
});

describe('line text', () => {
  it('says what the session does with `doing` first, else the tool line; expanded adds backend and time', async () => {
    const m = await mount();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    m.push([], [
      wireRow('s-a', { backend: 'codex', doing: '在跑 swift test', tool: 'Bash', target: 'build', started_at: S - 4 * 60 }),
      wireRow('s-b', { status: 'error', tool: 'Edit', target: 'HostLink.swift', updated_at: S - 6 * 60 }),
    ]);
    expand();
    const [b, a] = rows();
    expect(a!.querySelector('[data-hud-act]')?.textContent).toContain('在跑 swift test');
    expect(b!.querySelector('[data-hud-act]')?.textContent).toContain('改 HostLink.swift');
    expect(a!.querySelector('[data-hud-meta]')?.textContent).toBe('Codex 已 4 分');
    expect(b!.querySelector('[data-hud-meta]')?.textContent).toBe('Claude 6 分前');
    expect(a!.querySelector('[data-hud-title]')?.getAttribute('title')).toBe('会话 s-a');
  });

  it('gives an old session its age in whole hours or days, with the full readout as its tooltip', async () => {
    const m = await mount();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    m.push([], [wireRow('s-h', { updated_at: S - 95 * 60 }), wireRow('s-d', { updated_at: S - (541 * 60 + 12) * 60 })]);
    expand();
    const meta = (id: string) => rows().find((r) => r.dataset.hudRow === id)!.querySelector('[data-hud-meta]');
    expect(meta('s-h')?.textContent).toBe('Claude 1 小时前');
    expect(meta('s-d')?.textContent).toBe('Claude 22 天前');
    expect(meta('s-d')?.getAttribute('title')).toBe('Claude 22 天前');
  });

  it('a session waiting in its own app is a waiting line without 批准 or 拒绝; its title opens the session', async () => {
    const m = await mount();
    const jump = vi.spyOn(m.bridge.open, 'jumpToSession').mockResolvedValue();
    m.push([approval], [
      wireRow('s-run'),
      wireRow('s-own', { backend: 'codex', status: 'needs_you', state: 'awaiting_approval', doing: '待批准 make', own_app: true, approvals: [A2] }),
      wireRow('s-cc', { status: 'needs_you', state: 'awaiting_approval', own_app: true }),
    ]);
    await waitFor(() => expect(rows().length).toBe(1));
    expand();
    const own = rows().find((r) => r.dataset.hudRow === 's-own')!;
    expect(own.dataset.status).toBe('waiting');
    expect(own.querySelector('[data-hud-act]')?.textContent).toBe('│ 在 Codex 里等确认');
    expect(rows().find((r) => r.dataset.hudRow === 's-cc')!.querySelector('[data-hud-act]')?.textContent).toBe('│ 在 Claude 里等确认');
    expect(own.querySelector('[data-card-id]')).toBeNull();
    expect(within(own).queryByRole('button', { name: '批准' })).toBeNull();
    expect(within(own).queryByRole('button', { name: '拒绝' })).toBeNull();
    fireEvent.click(within(own).getByRole('button', { name: /会话 s-own/ }));
    expect(jump).toHaveBeenCalledWith('s-own');
    expect(readPresence({ sessions: [wireRow('s-own', { own_app: true }), wireRow('s-run')] }).sessions.map((s) => s.ownApp)).toEqual([true, false]);
  });

  it('drops a done line 8 seconds after it finished', async () => {
    const m = await mount();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    m.push([], [wireRow('s-done', { status: 'done', state: 'done', updated_at: S })]);
    expect(ids()).toEqual(['s-done']);
    act(() => vi.advanceTimersByTime(HUD_DONE_MS - 1));
    expect(ids()).toEqual(['s-done']);
    act(() => vi.advanceTimersByTime(1));
    expect(ids()).toEqual([]);
    expect(HUD_DONE_MS).toBe(8000);
  });
});

describe('agentd offline', () => {
  it('an offline mark keeps the last presence and marks it; a body after it clears the mark', () => {
    const last = { sampled_at: S, sessions: [wireRow('s-run')] };
    const offline = nextPresence(last, { offline: true });
    expect(readPresence(offline).offline).toBe(true);
    expect(readPresence(offline).sessions.map((s) => s.id)).toEqual(['s-run']);
    expect(readPresence(nextPresence(offline, { offline: true })).sessions.map((s) => s.id)).toEqual(['s-run']);
    expect(nextPresence(offline, last)).toBe(last);
    expect(readPresence(last).offline).toBe(false);
    expect(readPresence(nextPresence(null, { offline: true }))).toMatchObject({ offline: true, sessions: [] });
  });

  it('keeps the lines greyed out with their approvals inert until agentd answers again', async () => {
    const m = await mount();
    const root = () => document.querySelector<HTMLElement>('[data-surface-root="hud"]')!;
    const attached = () => rows()[0]!.querySelector(`[data-card-id="${A2}"]`)!.parentElement!;
    m.push([approval], [wireRow('s-run'), wireRow('s-wait', { status: 'needs_you', approvals: [A2] })]);
    await waitFor(() => expect(rows().length).toBe(1));
    expand();
    expect(root().hasAttribute('data-offline')).toBe(false);
    expect(attached().hasAttribute('inert')).toBe(false);
    m.presence({ offline: true });
    expect(ids()).toEqual(['s-wait', 's-run']);
    expect(root().hasAttribute('data-offline')).toBe(true);
    expect(attached().hasAttribute('inert')).toBe(true);
    m.push([approval], [wireRow('s-run'), wireRow('s-wait', { status: 'needs_you', approvals: [A2] })]);
    expect(root().hasAttribute('data-offline')).toBe(false);
    expect(attached().hasAttribute('inert')).toBe(false);
  });
});

describe('offline stack payload', () => {
  it('greys the lines while the pushed cards say the shell has lost agentd, and clears when they stop saying it', async () => {
    const m = await mount();
    const root = () => document.querySelector<HTMLElement>('[data-surface-root="hud"]')!;
    const attached = () => rows()[0]!.querySelector(`[data-card-id="${A2}"]`)!.parentElement!;
    const sessions = [wireRow('s-run'), wireRow('s-wait', { status: 'needs_you', approvals: [A2] })];
    m.push([approval], sessions);
    await waitFor(() => expect(rows().length).toBe(1));
    expand();
    expect(root().hasAttribute('data-offline')).toBe(false);
    m.payload({ now: NOW, cards: [approval], history: [], offline: true });
    expect(root().hasAttribute('data-offline')).toBe(true);
    expect(attached().hasAttribute('inert')).toBe(true);
    m.payload({ now: NOW, cards: [approval], history: [] });
    expect(root().hasAttribute('data-offline')).toBe(false);
  });
});

describe('seen', () => {
  it('opening a done or an error line marks it seen', async () => {
    const m = await mount();
    const jump = vi.spyOn(m.bridge.open, 'jumpToSession').mockResolvedValue();
    const request = vi.spyOn(m.bridge.agentd, 'request').mockResolvedValue({ status: 200, body: { seen: true } });
    m.push([], [wireRow('s-err', { status: 'error', state: 'error' }), wireRow('s-done', { status: 'done', state: 'done', updated_at: S })]);
    await waitFor(() => expect(rows().length).toBe(1));
    expand();
    for (const id of ['s-err', 's-done']) {
      fireEvent.click(within(rows().find((r) => r.dataset.hudRow === id)!).getByRole('button', { name: `会话 ${id}` }));
      expect(jump).toHaveBeenCalledWith(id);
      await waitFor(() => expect(request).toHaveBeenCalledWith('POST', '/desktop/sessions/seen', { session_id: id }));
    }
  });
});

describe('regions and commands', () => {
  it('reports no region with no line, and one once a line is up', async () => {
    const m = await mount();
    m.push([reminderCard], []);
    await act(async () => {});
    expect(m.regions.at(-1) ?? []).toEqual([]);
    m.push([], [wireRow('s-run')]);
    await waitFor(() => expect(m.regions.at(-1)?.length).toBeGreaterThan(0));
  });

  it('expandStack expands; focusTop expands and focuses the top waiting card', async () => {
    const m = await mount();
    m.push([approval], [wireRow('s-run'), wireRow('s-wait', { status: 'needs_you', approvals: [A2] })]);
    await waitFor(() => expect(rows().length).toBe(1));
    m.command({ kind: 'expandStack' });
    expect(rows().length).toBe(2);
    fireEvent.click(document.querySelector('[data-hud-fold]')!);
    expect(rows().length).toBe(1);
    m.command({ kind: 'focusTop' });
    expect(rows().length).toBe(2);
    await waitFor(() => expect(document.activeElement?.closest(`[data-card-id="${A2}"]`)).toBeTruthy());
  });

  it('关闭 on hover hides the bar until a new line or a new status arrives; 收起 stays', async () => {
    const m = await mount();
    const close = () => document.querySelector<HTMLElement>('[data-hud-close]');
    m.push([], [wireRow('s-run'), wireRow('s-err', { status: 'error' })]);
    await waitFor(() => expect(rows().length).toBe(1));
    expect(close()).toBeNull();
    fireEvent.mouseEnter(document.querySelector('[data-surface-root="hud"]')!);
    expect(close()?.hasAttribute('data-region')).toBe(true);
    expand();
    expect(document.querySelector('[data-hud-fold]')).not.toBeNull();
    fireEvent.click(within(document.body).getByRole('button', { name: '关闭' }));
    expect(rows()).toEqual([]);
    await waitFor(() => expect(m.regions.at(-1)).toEqual([]));
    m.push([], [wireRow('s-run'), wireRow('s-err', { status: 'error' })]);
    expect(rows()).toEqual([]);
    m.push([], [wireRow('s-run')]);
    expect(rows()).toEqual([]);
    m.push([], [wireRow('s-run', { status: 'error' })]);
    expect(ids()).toEqual(['s-run']);
    fireEvent.click(close()!);
    expect(rows()).toEqual([]);
    m.push([], [wireRow('s-run', { status: 'error' }), wireRow('s-new')]);
    expect(rows().length).toBe(1);
  });

  it('处理 expands and focuses that card', async () => {
    const m = await mount();
    m.push([approval], [wireRow('s-run')]);
    await waitFor(() => expect(rows().length).toBe(1));
    fireEvent.click(within(bar()).getByRole('button', { name: '处理' }));
    expect(rows()[0]!.querySelector(`[data-card-id="${A2}"]`)).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.closest(`[data-card-id="${A2}"]`)).toBeTruthy());
  });
});
