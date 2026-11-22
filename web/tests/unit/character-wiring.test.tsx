// Character wiring: agentd method, path and body per call, and what the page shows of agentd's shapes.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { AgentdCallError } from '../../src/bridge/agentd';
import { CHARACTER_LOOKS, NOW, STATE_LOG } from '../../src/mock/fixtures';
import { MOTIONS, routes, STATE_WITH_CAUSES, WIRE_STATE_WITH_CAUSES } from '../../src/mock/character';
import { failure, HISTORY_LIMIT, readHistory, readRunningTasks, readState, resetState } from '../../src/pages/character/api';
import { Operator, type OperatorProps } from '../../src/pages/character/Operator';
import { Stage, type StageProps } from '../../src/pages/character/Stage';
import { causeMarks } from '../../src/pages/character/StatePanel';
import { useSwitch } from '../../src/pages/character/useSwitch';
import type { CharacterState } from '../../src/domain';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so the page reads and shows what its plug-ins add.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

const noop = () => {};
const NOW_S = Math.floor(NOW / 1000);
let bridge: AgenticComplexBridge;

function install(over: Parameters<typeof createFakeBridge>[0] = { surface: 'main' }) {
  bridge = createFakeBridge({ still: true, ...over });
  window.agenticComplex = bridge;
  return vi.spyOn(bridge.agentd, 'request');
}

beforeEach(() => {
  install();
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  window.location.hash = '';
});

describe('character state reads', () => {
  it('reads GET /character/state and turns ISO cause times into ms and keeps the raw activity key', async () => {
    const spy = install();
    const s = await readState();
    expect(spy).toHaveBeenCalledWith('GET', '/character/state', undefined);
    expect(s?.character_id).toBe('si');
    expect(s?.activity).toBe('sit');
    expect(s?.affects_behavior).toBe(true);
    expect(s?.baseline).toBeUndefined();
    const first = WIRE_STATE_WITH_CAUSES.causes[0]!;
    expect(s?.causes[0]?.at).toBe(new Date(first.at).getTime());
  });

  it('reads 503 no_state as no state yet', async () => {
    window.location.hash = '#/character?demo=state-none';
    expect(await readState()).toBeNull();
    expect(await readHistory('24h', NOW)).toEqual([]);
  });

  it('reads GET /character/state/history since 24 h or 7 days ago, in epoch seconds, at agentd\'s row limit', async () => {
    const spy = install();
    const day = await readHistory('24h', NOW);
    expect(spy).toHaveBeenLastCalledWith('GET', `/character/state/history?since=${NOW_S - 86400}&limit=${HISTORY_LIMIT}`, undefined);
    expect(HISTORY_LIMIT).toBe(5000);
    expect(day).toEqual(STATE_LOG.d24);
    expect(day.at(-1)?.cause).toBe('user_spoke');
    const week = await readHistory('7d', NOW);
    expect(spy).toHaveBeenLastCalledWith('GET', `/character/state/history?since=${NOW_S - 7 * 86400}&limit=5000`, undefined);
    expect(week).toEqual(STATE_LOG.d7);
  });

  it('lists the running character tasks from GET /agent/tasks', async () => {
    const spy = install();
    const running = await readRunningTasks();
    expect(spy).toHaveBeenCalledWith('GET', '/agent/tasks?limit=100', undefined);
    expect(running.map((t) => t.title).sort()).toEqual(['修 HostLink 断线重连', '汇总 10 月开销表']);
  });
});

describe('character state reset', () => {
  it('sends DELETE /character/state {character_id} and returns the fresh state', async () => {
    const spy = install();
    const fresh = await resetState(STATE_WITH_CAUSES);
    expect(spy).toHaveBeenCalledWith('DELETE', '/character/state', { character_id: 'si' });
    expect(fresh.causes).toEqual([]);
    expect(fresh.labels.mood).toBe('steady');
  });

  it('says 已在别处更新 when the character changed meanwhile', async () => {
    const other: CharacterState = { ...STATE_WITH_CAUSES, character_id: 'voice_a' };
    const e = await resetState(other).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AgentdCallError);
    expect((e as AgentdCallError).code).toBe('character_changed');
    expect(failure(e)).toEqual({ kind: 'conflict', text: '已在别处更新' });
  });

  it('says 后台已断开 only for offline, and no raw JSON for other codes', () => {
    expect(failure(new AgentdCallError(0, 'offline', undefined, null, 'offline')).text).toBe('后台已断开');
    expect(failure(new AgentdCallError(0, 'route_class', undefined, null, 'x')).kind).toBe('other');
    expect(failure(new AgentdCallError(503, 'no_state', undefined, { error: 'no_state' }, 'x')).text).toBe('还没有状态');
    expect(failure(new AgentdCallError(500, 'http_500', undefined, { error: 1 }, 'x')).text).not.toContain('{');
  });
});

describe('mock routes in agentd shapes', () => {
  const route = (m: string, p: string) => routes.find((r) => r.method === m && r.path === p)!;
  it('rejects a reset without character_id like agentd', async () => {
    const r = await route('DELETE', '/character/state').handler({ method: 'DELETE', path: '/character/state', params: {}, query: new URLSearchParams(), body: undefined });
    expect(r).toEqual({ status: 400, body: { error: 'invalid_character_id' } });
  });
  it('answers history rows with epoch-second times and a 400 for a bad limit', async () => {
    const get = (q: string) => route('GET', '/character/state/history').handler({ method: 'GET', path: '/character/state/history', params: {}, query: new URLSearchParams(q), body: null });
    const r = (await get(`since=${NOW_S - 86400}&limit=5000`)) as { body: { items: Array<{ at: number }> } };
    expect(r.body.items.every((p) => p.at > 1e9 && p.at < 2e10)).toBe(true);
    expect(await get('limit=0')).toEqual({ status: 400, body: { error: 'invalid_limit' } });
  });
});

describe('state curve marks', () => {
  it('marks the two largest causes in range, one per half hour, in short words', () => {
    const marks = causeMarks(STATE_WITH_CAUSES.causes, NOW - 86400_000, NOW);
    expect(marks).toHaveLength(2);
    expect(marks.map((m) => m.label)).toContain('会话出错');
    expect(marks[0]!.t).toBeLessThan(marks[1]!.t);
    expect(Math.abs(marks[1]!.t - marks[0]!.t)).toBeGreaterThanOrEqual(30 * 60_000);
  });
});

const characters = [
  { id: 'si', name: '示例乙', en: 'SI', active: true, appearances: CHARACTER_LOOKS.si ?? [] },
  { id: 'voice_a', name: '示例甲', en: 'VOICE_A', active: false, appearances: CHARACTER_LOOKS.voice_a ?? [] },
];

function Op(over: Partial<OperatorProps> = {}) {
  return (
    <Operator
      roster={characters}
      current="si"
      sw={{ state: { phase: 'idle' }, request: noop, retry: noop, dismiss: noop }}
      offline={false}
      backoff={null}
      onRestart={noop}
      actions={MOTIONS}
      motionsError={null}
      onRetryMotions={noop}
      charState={STATE_WITH_CAUSES}
      toast={noop}
      {...over}
    />
  );
}

describe('operator view', () => {
  it('names the activity key in words on the stage', () => {
    render(<Op />);
    expect(document.querySelector('[data-stage]')?.textContent).toContain('坐着');
  });

  it('starts the look and size at what the avatar reports and leaves out the weapon switch without a host op', async () => {
    vi.spyOn(bridge.avatar, 'state').mockResolvedValue({ running: true, visible: true, scale: 1.25, clickThroughAll: false, speaking: false, characterId: 'si', appearanceId: 'uniform' });
    render(<Op pane="look" />);
    await waitFor(() => expect((screen.getByRole('slider', { name: '大小' }) as HTMLInputElement).value).toBe('125'));
    expect(within(screen.getByRole('listbox', { name: '外观' })).getByRole('option', { selected: true }).textContent).toContain('制服');
    expect(screen.queryByRole('option', { name: '武器' })).toBeNull();
  });

  it("leaves out today's plays where nobody counts them", () => {
    const { container } = render(<Op />);
    expect(container.textContent).not.toContain('今日播放');
    expect(container.textContent).toContain('桌面预览');
    expect(container.textContent).not.toContain('Today');
  });
});

describe('motions (avatar.actions shape)', () => {
  it('lists every section in words in one table, locks required ones and marks missing assets', () => {
    const { container } = render(<Op />);
    const grid = screen.getByRole('grid', { name: '全部动作' });
    expect(grid.textContent).toContain('说话');
    expect(grid.textContent).toContain('移动与姿态');
    expect(grid.textContent).not.toContain('talk');
    expect(screen.getByRole('switch', { name: '开口说话' }).getAttribute('aria-disabled')).toBe('true');
    expect(container.textContent).toContain('必需');
    // The compact table keeps no trigger column; the missing reason shows on the stage and the full table on 调参.
    expect(grid.querySelector('[data-motion="think"]')?.hasAttribute('data-miss')).toBe(true);
  });

  it('saves through setActionSwitches and keeps the table the host sends back', async () => {
    const toast = vi.fn();
    const set = vi.spyOn(bridge.avatar, 'setActionSwitches').mockResolvedValue({ switches: { nod: true }, adjusted: [{ id: 'nod', reason: 'last_in_section' }] });
    render(<Op toast={toast} />);
    fireEvent.click(screen.getByRole('switch', { name: '点头附和' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ nod: false }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(String(toast.mock.calls[0]?.[0])).toContain('分区里至少留一个');
    expect(screen.getByRole('switch', { name: '点头附和' }).getAttribute('aria-checked')).toBe('true');
  });

  it('shows a default-off action off and writes true when the user first turns it on', async () => {
    const attack = { id: 'attack', label: '攻击', enabled: false, defaultEnabled: false, section: 'react', trigger: '手动', durationS: 1.5, isNew: false, missingReason: null, playable: true };
    const set = vi.spyOn(bridge.avatar, 'setActionSwitches').mockResolvedValue({ switches: { attack: true }, adjusted: [] });
    render(<Op actions={[...MOTIONS, attack]} />);
    const sw = screen.getByRole('switch', { name: '攻击' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ attack: true }));
    await waitFor(() => expect(screen.getByRole('switch', { name: '攻击' }).getAttribute('aria-checked')).toBe('true'));
  });

  it('names why the host refused to play', async () => {
    const toast = vi.fn();
    vi.spyOn(bridge.avatar, 'playAction').mockRejectedValue({ code: 'busy' });
    render(<Op toast={toast} />);
    fireEvent.click(screen.getByRole('button', { name: /桌面预览/ }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(String(toast.mock.calls.at(-1)?.[0])).toContain('稍后再播');
  });

  it('says the host gave no reason, in Chinese, for codes it does not know', async () => {
    const toast = vi.fn();
    vi.spyOn(bridge.avatar, 'playAction').mockRejectedValue({ code: 'queue_full' });
    vi.spyOn(bridge.avatar, 'setActionSwitches').mockResolvedValue({ switches: {}, adjusted: [], error: 'table_locked' });
    render(<Op toast={toast} />);
    fireEvent.click(screen.getByRole('button', { name: /桌面预览/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByRole('switch').find((s) => s.getAttribute('aria-disabled') !== 'true')!);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    const said = toast.mock.calls.map((c) => String(c[0]));
    expect(said[0]).toContain('桌面角色未确认播放');
    expect(said[1]).toContain('桌面角色没有给出原因');
    expect(said.join()).not.toMatch(/queue_full|table_locked/);
  });
});

const stageProps: StageProps = {
  motion: MOTIONS[1],
  section: '说话',
  name: '示例乙',
  activity: '坐着',
  scale: 100,
  offline: false,
  backoff: null,
  onRestart: noop,
  sw: { phase: 'idle' },
  currentName: '示例乙',
  onRetry: noop,
  onDismiss: noop,
  play: null,
};

const CEDAR = { id: 'cedar', name: '示例丙', en: 'CEDAR', active: false };

describe('switching', () => {
  function Harness() {
    // Every switch asks first; the harness confirms at once.
    const sw = useSwitch({ initial: { phase: 'idle' }, runningTasks: async () => [], ask: (spec) => spec.onConfirm(), onDone: noop });
    return (
      <>
        <button type="button" onClick={() => sw.request(CEDAR, 'si', '示例乙')}>
          go
        </button>
        <Stage {...stageProps} sw={sw.state} onRetry={sw.retry} onDismiss={sw.dismiss} />
      </>
    );
  }

  it('asks first and says what happens to the current character', async () => {
    const ask = vi.fn();
    function Asking() {
      const sw = useSwitch({ initial: { phase: 'idle' }, runningTasks: async () => [], ask, onDone: noop });
      return (
        <button type="button" onClick={() => sw.request(CEDAR, 'si', '示例乙')}>
          go
        </button>
      );
    }
    const to = vi.spyOn(bridge.character, 'switchTo');
    render(<Asking />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'go' })));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[0].note).toContain('示例乙 先从桌面隐藏');
    expect(to).not.toHaveBeenCalled();
  });

  it('calls character.switchTo after the confirm and stops at the stage the shell names', async () => {
    const to = vi.spyOn(bridge.character, 'switchTo');
    render(<Harness />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'go' })));
    expect(to).toHaveBeenCalledWith('cedar');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('加载资源失败');
  });

  it('says a host reason code in Chinese at the stage it stopped', async () => {
    vi.spyOn(bridge.character, 'switchTo').mockResolvedValue({ ok: false, stage: 'prepare', reason: 'superseded' });
    render(<Harness />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'go' })));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('被后来的切换取代');
    expect(alert.textContent).not.toContain('superseded');
    expect(alert.textContent).toContain('停在这里');
  });

  it('says 角色还没连上 when the shell has no avatar to switch', async () => {
    vi.spyOn(bridge.character, 'switchTo').mockRejectedValue({ code: 'unavailable', detail: '角色还没连上' });
    render(<Harness />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'go' })));
    expect((await screen.findByRole('alert')).textContent).toContain('角色还没连上');
  });

  it('shows the switch without made-up stage progress while it runs', async () => {
    vi.spyOn(bridge.character, 'switchTo').mockReturnValue(new Promise(noop));
    render(<Harness />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'go' })));
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('正在切换到 示例丙');
    expect(status.textContent).not.toContain('完成');
  });

  it('says the host gave no reason instead of its English detail or code', async () => {
    vi.spyOn(bridge.character, 'switchTo').mockRejectedValue({ code: 'bundle_mismatch', detail: 'Bundle hash does not match' });
    render(<Harness />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'go' })));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('桌面角色没有给出原因');
    expect(alert.textContent).not.toMatch(/bundle_mismatch|Bundle hash/);
  });
});

describe('offline overlay', () => {
  it('says the backoff seconds without a made-up countdown', () => {
    render(<Stage {...stageProps} offline backoff={8} />);
    expect(screen.getByRole('status').textContent).toContain('退避 8 秒后重试');
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('leaves out the backoff when the shell gives none', () => {
    render(<Stage {...stageProps} offline />);
    expect(screen.getByRole('status').textContent).not.toContain('退避');
    expect(screen.getByRole('button', { name: '重启角色' })).toBeTruthy();
  });
});
