import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { actionLine, toolAction } from '../../src/features/approval';
import type { StackPayload } from '../../src/bridge/protocol';
import { stackScenario } from '../../src/mock/stack';
import { NOW } from '../../src/mock/fixtures';
import { A1, A2, A3, Q1, S_5E10, S_9A41, S_C07A, S_D0C2 } from '../../src/mock/fixtures/ids';
import type { StackCard } from '../../src/surfaces/stack/model';
import { groupStack, isChatCard, presenceSessions, type SessionRow } from '../../src/surfaces/stack/sessions';
import { HudRoot } from '../../src/surfaces/desktop/HudRoot';
import { stubMatchMedia } from './mediaStub';

// Presence sessions and the cards that sit on them, drawn as the HUD's session lines.

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
  return { id, backend: 'claude', title: `会话 ${id.slice(-4)}`, state: 'running', updated_at: S - 120, tool: null, target: null, approvals: [], status: 'running', activity: '在跑', ...extra };
}

const presenceOf = (sessions: unknown[], additional = 0) => ({ sampled_at: S, sessions, additional_sessions: additional, thought: null });

const row = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, backend: 'claude', title: id, status: 'running', live: false, activity: '在跑', tool: null, target: null, updatedAt: NOW - 60_000, approvals: [], ...extra });

const card = (scenario: string, id: string): StackCard => {
  const c = stackScenario(scenario).cards.find((x) => x.id === id);
  if (!c) throw new Error(`no ${id} in ${scenario}`);
  return c;
};
const notices = stackScenario('notices').cards;
const reviewCard = stackScenario('review').cards.find((c) => c.kind === 'review')!;
const deliveryCard = stackScenario('delivery').cards.find((c) => c.kind === 'delivery')!;
const reminderCard = stackScenario('delivery').cards.find((c) => c.kind === 'notice')!;
const errorCard = stackScenario('task-error').cards.find((c) => c.kind === 'error')!;
const lookCard = stackScenario('task-error').cards.find((c) => c.kind === 'notice')!;
const nativeCards = [...stackScenario('desktop').cards, ...stackScenario('desktop-progress').cards];
const computerCard = nativeCards.find((c) => c.kind === 'notice' && c.variant === 'computer')!;
const dropCard: StackCard = { id: 'drop-1', kind: 'notice', variant: 'drop', at: NOW, title: '拖入 1 个文件', items: [{ kind: 'file', path: '/tmp/a.txt', name: 'a.txt' }], truncated: false };

describe('presence session rows', () => {
  it('reads the rows in epoch ms with additional_sessions as the rest, and skips junk', () => {
    const got = presenceSessions(presenceOf([wireRow(S_5E10, { status: 'needs_you', state: 'running_tool', approvals: [A1], tool: 'Bash', target: 'build' }), null, { title: 'no id' }], 3));
    expect(got.more).toBe(3);
    expect(got.rows).toEqual([
      { id: S_5E10, backend: 'claude', title: `会话 ${S_5E10.slice(-4)}`, status: 'needs_you', live: true, activity: '在跑', tool: 'Bash', target: 'build', updatedAt: NOW - 120_000, approvals: [A1] },
    ]);
    expect(presenceSessions(presenceOf([wireRow(S_5E10, { state: 'thinking' })])).rows[0]?.live).toBe(false);
    expect(presenceSessions(null)).toEqual({ rows: [], more: 0 });
  });
});

describe('a session row action', () => {
  it('says what the tool does to its target with the approval verbs, and the tool alone when it names none', () => {
    const say = (tool: string, target: string | null) => {
      const a = toolAction(tool, target);
      return [a.verb, a.target].filter(Boolean).join(' ');
    };
    expect(say('Bash', 'swift')).toBe('运行 swift');
    expect(say('Bash', 'Run the host tests')).toBe('Run the host tests');
    expect(say('Edit', 'HostLink.swift')).toBe('改 HostLink.swift');
    expect(say('Read', 'README.md')).toBe('读取 README.md');
    expect(say('Grep', null)).toBe('搜索');
    expect(say('WebFetch', 'api.github.com')).toBe('访问 api.github.com');
    expect(say('Task', '查一下构建脚本')).toBe('查一下构建脚本');
    expect(say('Mystery', null)).toBe('Mystery');
  });
});

describe('MCP action lines', () => {
  it('uses Chinese copy for user MCP tools in session and approval lines without a raw prefix', () => {
    const tool = 'mcp__github__create_issue';
    const lines = [
      toolAction(tool, 'github │ create_issue'), toolAction(tool, null),
      actionLine({ tool, cmd: 'github │ create_issue', title: tool, dispatch: null }),
      actionLine({ tool, title: tool, dispatch: null }),
    ];
    for (const line of lines) {
      expect([line.verb, line.target].filter(Boolean).join(' ')).toBe('用 github 的 create_issue');
      expect(JSON.stringify(line)).not.toContain('mcp__');
    }
  });

  it('hides internal tool targets on session rows even if older presence data still contains them', () => {
    for (const tool of ['mcp__ccd_turn__wrap_up', 'mcp__ccd_plan__update', 'mcp__agentic_complex__receipt_check']) {
      for (const line of [toolAction(tool, null), toolAction(tool, 'ccd_turn │ wrap_up')]) {
        expect(line.target).toBe('');
        expect(JSON.stringify(line)).not.toContain('mcp__');
      }
    }
  });

  it('still names an internal tool on an approval, since the user decides what runs', () => {
    const line = actionLine({ tool: 'mcp__ccd_turn__wrap_up', title: 'mcp__ccd_turn__wrap_up', dispatch: null });
    expect(line.full).toBe('用 ccd_turn 的 wrap_up');
  });
});

describe('grouping cards into sessions', () => {
  it("attaches an approval whose id is in a session's approvals", () => {
    const { sessions, standalone } = groupStack([card('default', A1)], [row(S_9A41), row('other', { approvals: [A1] })]);
    expect(sessions.find((g) => g.row.id === 'other')?.cards.map((c) => c.id)).toEqual([A1]);
    expect(standalone).toEqual([]);
  });

  it("attaches a question by the session's approvals and an approval by its display session", () => {
    const { sessions, standalone } = groupStack([card('default', Q1), card('default', A2), card('default', A3)], [row(S_C07A), row(S_9A41, { approvals: [Q1] })]);
    expect(sessions.find((g) => g.row.id === S_C07A)?.cards.map((c) => c.id).sort()).toEqual([A2, A3].sort());
    expect(sessions.find((g) => g.row.id === S_9A41)?.cards.map((c) => c.id)).toEqual([Q1]);
    expect(standalone).toEqual([]);
  });

  it('keeps unmatched approvals, questions, reviews, errors and 电脑操作 as standalone rows', () => {
    const cards = [card('default', A1), card('default', Q1), reviewCard, errorCard, computerCard];
    const { sessions, standalone } = groupStack(cards, [row(S_9A41)]);
    expect(sessions[0]?.cards).toEqual([]);
    expect(standalone.map((c) => c.id).sort()).toEqual(cards.map((c) => c.id).sort());
    // 电脑操作 (P0) stays first.
    expect(standalone[0]?.id).toBe(computerCard.id);
  });

  it('leaves the chat window kinds out: reminder, brief, done, look, resume, loading, voice hint, drop; a delivery stays', () => {
    const chat = [...notices, reminderCard, lookCard, dropCard, ...nativeCards.filter((c) => c.kind === 'notice' && c.variant !== 'computer')];
    const variants = new Set(chat.map((c) => (c.kind === 'notice' ? c.variant : c.kind)));
    expect(variants).toEqual(new Set(['resume', 'done', 'brief', 'reminder', 'look', 'drop', 'voice', 'loading']));
    expect(chat.every(isChatCard)).toBe(true);
    expect([computerCard, errorCard, reviewCard, deliveryCard, card('default', A1)].some(isChatCard)).toBe(false);
    const { standalone } = groupStack([...chat, errorCard, deliveryCard], [row(S_9A41)]);
    expect(standalone.map((c) => c.id).sort()).toEqual([errorCard.id, deliveryCard.id].sort());
  });

  it('a chat card brought back from history shows again', () => {
    expect(groupStack([reminderCard], [], [reminderCard.id]).standalone.map((c) => c.id)).toEqual([reminderCard.id]);
  });

  it("trusts presence's order, and lifts a session a waiting card attached to", () => {
    const rows = [row('r-done', { status: 'done' }), row('r-run', { status: 'running', updatedAt: NOW }), row('r-err', { status: 'error' })];
    expect(groupStack([], rows).sessions.map((g) => g.row.id)).toEqual(['r-done', 'r-run', 'r-err']);
    const lifted = groupStack([card('default', A2)], [...rows, row(S_C07A)]).sessions;
    expect(lifted.map((g) => g.row.id)).toEqual([S_C07A, 'r-done', 'r-run', 'r-err']);
    expect(lifted[0]?.status).toBe('needs_you');
    expect(lifted.slice(1).map((g) => g.status)).toEqual(['done', 'running', 'error']);
  });
});

/** Mounts the HUD with the pushes under the test's control. */
async function mount(hash = '#/hud?still=1') {
  let pushCards: ((p: StackPayload) => void) | undefined;
  let pushPresence: ((raw: unknown) => void) | undefined;
  const bridge = getBridge();
  vi.spyOn(bridge.stack, 'onCards').mockImplementation((cb) => {
    pushCards = cb;
    return () => {};
  });
  vi.spyOn(bridge.desktop, 'onPresence').mockImplementation((cb) => {
    pushPresence = cb;
    return () => {};
  });
  window.location.hash = hash;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <HudRoot />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(pushCards && pushPresence).toBeDefined());
  return {
    ...view,
    bridge,
    push(cards: StackCard[], sessions: unknown[], additional = 0, now = NOW) {
      act(() => {
        pushPresence!(presenceOf(sessions, additional));
        pushCards!({ now, cards, history: [] });
      });
    },
    presence(sessions: unknown[], additional = 0) {
      act(() => pushPresence!(presenceOf(sessions, additional)));
    },
  };
}

const lines = () => [...document.querySelectorAll<HTMLElement>('[data-hud-row]')];
const expand = () => fireEvent.click(screen.getByRole('button', { name: /^展开全部/ }));

describe('session lines on the HUD', () => {
  it('labels each status in Chinese', async () => {
    const m = await mount();
    m.push([], ['needs_you', 'error', 'done', 'running'].map((status, i) => wireRow(`s-${i}`, { status, updated_at: S })));
    expand();
    expect(lines().map((e) => e.querySelector('[data-glyph]')?.getAttribute('aria-label'))).toEqual(['待处理', '出错', '运行中', '完成']);
  });

  it('keeps the expanded state across later pushes', async () => {
    const m = await mount();
    const rows = [wireRow(S_5E10), wireRow(S_9A41), wireRow(S_D0C2)];
    m.push([], rows);
    expand();
    m.push([card('default', A1)], rows);
    m.presence(rows.slice(0, 2));
    expect(lines().length).toBe(2);
    expect(screen.getByRole('button', { name: '收起' })).toBeTruthy();
  });

  it('removes an approval answered elsewhere after 3.2 seconds, even across repeated pushes', async () => {
    const m = await mount('#/hud?');
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const pending = card('default', A1);
    if (pending.kind !== 'approval') throw new Error('no approval');
    const rows = [wireRow(S_5E10, { tool: 'Bash', target: 'swift test' })];
    m.push([pending], rows);
    expand();
    expect(screen.getByRole('button', { name: '批准' })).toBeTruthy();

    const answered: StackCard = { ...pending, outcome: { kind: 'elsewhere', at: NOW, text: '已在别处处理' } };
    m.push([answered], rows);
    expect(screen.getByText('这张卡被别处处理了，这里不用再点')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
    act(() => vi.advanceTimersByTime(1600));
    m.push([{ ...answered }], rows, 0, NOW + 1600);
    act(() => vi.advanceTimersByTime(1599));
    expect(screen.getByText('这张卡被别处处理了，这里不用再点')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    const line = lines()[0]!;
    expect(line.querySelector('[data-stub="SessionApproval"]')).toBeNull();
    expect(line.querySelector('[data-danger-mark]')).toBeNull();
    expect(line.textContent).not.toContain('已在别处处理');
    expect(line.querySelector('[data-hud-act]')?.textContent).toBe('│ swift test');
  });

  it.each(['pending', 'elsewhere', 'approved'] as const)('a session ending with a %s approval shows only its normal tool line', async (kind) => {
    const m = await mount();
    const pending = card('default', A1);
    if (pending.kind !== 'approval') throw new Error('no approval');
    const approval: StackCard = kind === 'pending' ? pending : { ...pending, outcome: { kind, at: NOW, text: '已在别处处理' } };
    m.push([approval], [wireRow(S_5E10, { approvals: [A1] })]);
    expand();
    expect(lines()[0]!.querySelector('[data-stub="SessionApproval"]')).toBeTruthy();

    m.presence([wireRow(S_5E10, { status: 'done', state: 'ended', approvals: [A1], tool: 'Bash', target: 'swift test', updated_at: S })]);
    const line = lines()[0]!;
    expect(line.querySelector('[data-stub="SessionApproval"]')).toBeNull();
    expect(line.querySelector('[data-danger-mark]')).toBeNull();
    expect(line.textContent).not.toContain('已在别处处理');
    expect(line.dataset.status).toBe('done');
    expect(line.querySelector('[data-hud-act]')?.textContent).toBe('│ swift test');
    expect(document.querySelector(`[data-card-id="${A1}"]`)).toBeNull();
  });
});
