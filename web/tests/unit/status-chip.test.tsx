import { act as flush, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { DesktopAnchor, DesktopCommand, DesktopState, AgenticComplexBridge, StackPayload, StreamEvent } from '../../src/bridge/protocol';
import { BubbleRoot } from '../../src/surfaces/desktop/BubbleRoot';
import { ChipRoot } from '../../src/surfaces/desktop/ChipRoot';
import type { Bar, Phase } from '../../src/surfaces/desktop/comm/commReducer';
import { CHIP_DONE_MS, chipOf, type ChipKind } from '../../src/surfaces/desktop/tags/presence';
import { stubMatchMedia } from './mediaStub';

// The status chip beside her for states with no message (`#/chip`), and the bubble drawing no card for them.

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.agenticComplex;
  window.location.hash = '';
});

const SAMPLED = 1_800_000_000;
const NOW = SAMPLED * 1000;
const THOUGHT = { id: 't1', text: '测试又红了，像是同一个超时。', offer: '帮我看看', reply: '好，帮我看看', reason: 'error', at: SAMPLED, session_id: null };
const role = (state: string, extra: Record<string, unknown> = {}) => ({ state, run_id: 'r1', since: SAMPLED - 300, doing: `正在 ${state}`, ...extra });
const presenceOf = (extra: Record<string, unknown> = {}) => ({ sampled_at: SAMPLED, proactive_speech: true, thought: null, role: role('idle'), ...extra });
const barOf = (phase: Phase, extra: Partial<Bar> = {}): Bar => ({
  id: 'l1', kind: 'main', text: phase === 'thinking' ? '' : '好的。', phase, reason: null, pinned: false, held: false, left: 4000, total: 4000, seq: 1, ...extra,
});
const kind = (raw: unknown, bar: Bar | null = null, now = NOW): ChipKind | null => chipOf(raw, bar, now)?.kind ?? null;

describe('chipOf', () => {
  it('spins for every role state at work', () => {
    for (const state of ['thinking', 'running_tool', 'subagent', 'compacting', 'background']) expect(kind(presenceOf({ role: role(state) })), state).toBe('running');
  });

  it('shows the thinking dots for a new turn before her first word', () => {
    expect(kind(presenceOf(), barOf('thinking'))).toBe('thinking');
    expect(kind(presenceOf({ role: role('thinking') }), barOf('thinking'))).toBe('thinking');
  });

  it('shows nothing while she is idle, keeping you company, or stale', () => {
    expect(kind(presenceOf())).toBeNull();
    expect(kind(presenceOf({ role: role('idle', { activity: '陪着你' }) }))).toBeNull();
    expect(kind(presenceOf({ role: role('stale') }))).toBeNull();
    expect(kind(null)).toBeNull();
    expect(kind(presenceOf(), barOf('streaming'))).toBeNull();
  });

  it('greys out offline, over everything else', () => {
    expect(kind({ ...presenceOf({ role: role('awaiting_approval') }), offline: true })).toBe('offline');
  });

  it('pulses amber with the count for approvals, questions and own-app waits', () => {
    expect(chipOf(presenceOf({ role: role('awaiting_approval') }), null, NOW)).toMatchObject({ kind: 'waiting', count: 1 });
    expect(chipOf(presenceOf({ role: role('awaiting_input') }), null, NOW)).toMatchObject({ kind: 'waiting', count: 1 });
    const pending = { approvals: [{ id: 'a1' }, { id: 'a2' }], questions: [{ id: 'q1' }], approvals_more: 2 };
    expect(chipOf(presenceOf({ role: role('running_tool'), pending }), null, NOW)).toMatchObject({ kind: 'waiting', count: 5 });
    const sessions = [{ id: 's1', title: 'Claude', state: 'awaiting_approval', status: 'needs_you', own_app: true }];
    expect(chipOf(presenceOf({ sessions }), null, NOW)).toMatchObject({ kind: 'waiting', count: 1 });
  });

  it('ticks for 8 s after a run or a session is done', () => {
    const agent = { state: 'done', since: SAMPLED, count: 1 };
    expect(chipOf(presenceOf({ agent }), null, NOW + 1000)).toMatchObject({ kind: 'done', until: NOW + CHIP_DONE_MS });
    expect(kind(presenceOf({ agent }), null, NOW + CHIP_DONE_MS)).toBeNull();
    const sessions = [{ id: 's1', title: 'Codex', state: 'done', status: 'done', updated_at: SAMPLED - 2 }];
    expect(kind(presenceOf({ sessions }), null, NOW)).toBe('done');
    expect(kind(presenceOf({ sessions }), null, NOW + CHIP_DONE_MS)).toBeNull();
  });

  it('crosses red for an error until it is seen', () => {
    const line = chipOf(presenceOf({ role: role('running_tool') }), barOf('error'), NOW);
    expect(line).toMatchObject({ kind: 'error', errors: ['line:l1'] });
    expect(kind(presenceOf({ role: role('running_tool') }), barOf('error'))).toBe('error');
    expect(chipOf(presenceOf({ role: role('running_tool') }), barOf('error'), NOW, new Set(line!.errors))?.kind).toBe('running');
    const sessions = [{ id: 's1', title: 'Codex', state: 'error', status: 'error' }];
    expect(chipOf(presenceOf({ sessions }), null, NOW)).toMatchObject({ kind: 'error', errors: ['session:s1'] });
    expect(kind(presenceOf({ agent: { state: 'failed', since: SAMPLED, count: 1 } }))).toBe('error');
    expect(chipOf(presenceOf({ sessions }), null, NOW, new Set(['session:s1']))).toBeNull();
  });

  it('flashes once for an interrupted line', () => {
    expect(kind(presenceOf(), barOf('interrupted', { left: 3800 }))).toBe('interrupted');
    expect(kind(presenceOf(), barOf('interrupted', { left: 2000 }))).toBeNull();
  });
});

/** BubbleRoot on the fake bridge, with presence, cards, `/feed` and commands pushed by the test. */
function mountBubble() {
  const bridge: AgenticComplexBridge = createFakeBridge({ surface: 'stack', still: true });
  window.agenticComplex = bridge;
  window.location.hash = '#/bubble';
  let presence: ((raw: unknown) => void) | null = null;
  let cards: ((p: StackPayload) => void) | null = null;
  const feed = new Set<(e: StreamEvent) => void>();
  const commands = new Set<(c: DesktopCommand) => void>();
  vi.spyOn(bridge.desktop, 'onPresence').mockImplementation((cb) => ((presence = cb), () => {}));
  vi.spyOn(bridge.stack, 'onCards').mockImplementation((cb) => ((cards = cb), () => {}));
  vi.spyOn(bridge.feed, 'subscribe').mockImplementation((cb) => (feed.add(cb), () => feed.delete(cb)));
  vi.spyOn(bridge.desktop, 'onCommand').mockImplementation((cb) => (commands.add(cb), () => commands.delete(cb)));
  render(<BubbleRoot />);
  const send = (event: string, data: object) => flush(async () => feed.forEach((cb) => cb({ event, id: 'x', data: JSON.stringify(data) })));
  return {
    presence: (raw: unknown) => flush(async () => presence?.(raw)),
    cards: (list: StackPayload['cards']) => flush(async () => cards?.({ now: NOW, cards: list, history: [] })),
    command: (c: DesktopCommand) => flush(async () => commands.forEach((cb) => cb(c))),
    line: (id: string, text: string) => send('line', { line_id: id, text_delta: text, final: false, cancelled: false, error: null, lane: 'character', reason: null }),
    accepted: (id: string) => send('turn_accepted', { line_id: id, conversation_id: null, source: 'text', trace_id: `tr-${id}`, side: false }),
  };
}

const regions = () => document.querySelectorAll('[data-surface-root="bubble"] [data-region]').length;

describe('the bubble opens only for something to read or answer', () => {
  it('draws no card for a thinking bar or the 正在做 row alone', async () => {
    const b = mountBubble();
    await b.presence(presenceOf({ role: role('running_tool') }));
    expect(regions()).toBe(0);
    await b.accepted('u1');
    expect(regions()).toBe(0);
    await b.presence(presenceOf({ thought: THOUGHT }));
    expect(regions()).toBe(0);
  });

  it('opens for her streaming line, a due reminder, an offered thought and a notice', async () => {
    const b = mountBubble();
    await b.presence(presenceOf());
    await b.line('l1', '我看看');
    expect(regions()).toBeGreaterThan(0);
    cleanup();

    const r = mountBubble();
    await r.cards([{ id: 'rem-c1', kind: 'notice', variant: 'reminder', at: NOW, title: 'c1 组会', commitment_id: 'c1' }]);
    expect(regions()).toBeGreaterThan(0);
    cleanup();

    const t = mountBubble();
    await t.presence(presenceOf({ thought: THOUGHT }));
    screen.getByRole('button', { name: '帮我看看' });
    expect(regions()).toBeGreaterThan(0);
    cleanup();

    const n = mountBubble();
    await n.presence(presenceOf());
    await n.command({ kind: 'notice', text: '她在忙，等这一轮做完' });
    expect(regions()).toBeGreaterThan(0);
  });

  it('keeps the same glass, the whole card, from her thought to her line', async () => {
    const b = mountBubble();
    await b.presence(presenceOf({ thought: THOUGHT }));
    const before = [...document.querySelectorAll('[data-glass]')];
    expect(before).toEqual([document.querySelector('[data-bubble]')]);
    await b.line('l1', '我看看');
    screen.getByText('我看看');
    expect([...document.querySelectorAll('[data-glass]')]).toEqual(before);
  });

  it('drags by the whole header', async () => {
    const b = mountBubble();
    await b.presence(presenceOf({ thought: THOUGHT }));
    const drag = document.querySelector('[data-drag]');
    expect(drag?.tagName).toBe('HEADER');
    expect(drag?.querySelector('[data-bubble-doing]')).not.toBeNull();
  });
});

const state = (extra: Partial<DesktopState> = {}): DesktopState => ({
  hidden: false, clickThroughAll: false, freeRoam: false, quietUntil: null, avatarHovered: false, character: null, characters: [], screens: [], hotkeys: {},
  pips: { agentd: { state: 'running', pid: 1, backoff: null }, avatar: { state: 'running', pid: 2, backoff: null }, voice: 'on' }, computerUseActive: false, ...extra,
});
const ANCHOR: DesktopAnchor = { panel: 'hud', state: 'settled', side: 'right', docked: null, far: false, toHead: { dx: -40, dy: 0 }, room: { width: 400, height: 400 } };

/** ChipRoot on the fake bridge, with presence, desktop state and anchor pushed by the test. */
function mountChip() {
  const bridge: AgenticComplexBridge = createFakeBridge({ surface: 'stack', still: true });
  window.agenticComplex = bridge;
  window.location.hash = '#/chip';
  let presence: ((raw: unknown) => void) | null = null;
  let onState: ((s: DesktopState) => void) | null = null;
  let onAnchor: ((a: DesktopAnchor) => void) | null = null;
  vi.spyOn(bridge.desktop, 'onPresence').mockImplementation((cb) => ((presence = cb), () => {}));
  vi.spyOn(bridge.desktop, 'onState').mockImplementation((cb) => ((onState = cb), () => {}));
  vi.spyOn(bridge.window, 'onAnchor').mockImplementation((cb) => ((onAnchor = cb), () => {}));
  vi.spyOn(bridge.feed, 'subscribe').mockImplementation(() => () => {});
  const action = vi.spyOn(bridge.desktop, 'action').mockResolvedValue(undefined);
  render(<ChipRoot />);
  return {
    action,
    push: (raw: unknown, s: Partial<DesktopState> = {}, a: DesktopAnchor = ANCHOR) =>
      flush(async () => {
        onAnchor?.(a);
        onState?.(state(s));
        presence?.(raw);
      }),
  };
}

const chip = () => document.querySelector<HTMLElement>('[data-surface-root="chip"] [data-chip]');

describe('the status chip page', () => {
  it('is one 36 px circle, the only region, with the 正在做 line as its tip', async () => {
    const c = mountChip();
    await c.push(presenceOf({ role: role('running_tool', { doing: '在跑 swift test' }) }));
    expect(chip()?.dataset.chip).toBe('running');
    expect(document.querySelectorAll('[data-region]')).toEqual(document.querySelectorAll('[data-chip]'));
    fireEvent.mouseEnter(chip()!);
    expect(screen.getByRole('tooltip').textContent).toBe('▸ 在跑 swift test │ 5 分钟');
  });

  it('unfolds the HUD for a wait or an error, else opens the bubble', async () => {
    const c = mountChip();
    await c.push(presenceOf({ role: role('awaiting_approval') }));
    expect(chip()?.textContent).toBe('1');
    fireEvent.click(chip()!);
    expect(c.action).toHaveBeenLastCalledWith('openStack');
    await c.push(presenceOf({ role: role('running_tool') }));
    fireEvent.click(chip()!);
    expect(c.action).toHaveBeenLastCalledWith('quickInput');
  });

  it('drops an error once it is opened', async () => {
    const c = mountChip();
    await c.push(presenceOf({ sessions: [{ id: 's1', title: 'Codex', state: 'error', status: 'error' }] }));
    expect(chip()?.dataset.chip).toBe('error');
    await flush(async () => fireEvent.click(chip()!));
    expect(c.action).toHaveBeenLastCalledWith('openStack');
    expect(chip()).toBeNull();
  });

  it('hides while the ring is open over her, or while she is docked, and shows nothing while she idles', async () => {
    const c = mountChip();
    await c.push(presenceOf({ role: role('running_tool') }), { avatarHovered: true });
    expect(chip()).toBeNull();
    await c.push(presenceOf({ role: role('running_tool') }), { avatarHovered: false }, { ...ANCHOR, state: 'docked', docked: 'noroom' });
    expect(chip()).toBeNull();
    await c.push(presenceOf({ role: role('running_tool') }));
    expect(chip()).not.toBeNull();
    await c.push(presenceOf());
    expect(document.querySelectorAll('[data-region]')).toHaveLength(0);
  });
});
