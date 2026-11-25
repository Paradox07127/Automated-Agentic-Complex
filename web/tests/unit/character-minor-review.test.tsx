// Minor findings of the 11-22 review on the character page: the roster closes on Escape, a head says why it is off while she is not running, an IME Enter does not save a rename, the default motion is one the table shows, ?pane=chain without 编排 opens 动作表, a package id named like an Object member has no 模组设置, and a slower task read does not ask about a head the user moved away from.
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AvatarAction } from '../../src/bridge/protocol';
import { MOTIONS } from '../../src/mock/character';
import { HeadStrip } from '../../src/pages/character/HeadStrip';
import { MotionEditDialog } from '../../src/pages/character/MotionEditDialog';
import { Operator, type OperatorProps } from '../../src/pages/character/Operator';
import type { MotionLibrary } from '../../src/pages/character/useMotionLibrary';
import { useSwitch } from '../../src/pages/character/useSwitch';

const noop = () => {};
const ROSTER = [
  { id: 'si', name: '示例乙', en: 'SI', active: true, voice: true, appearances: [] },
  { id: 'voice_a', name: '示例甲', en: 'VOICE_A', active: false, voice: true, appearances: [] },
  { id: 'cedar', name: '示例丙', en: 'CEDAR', active: false, voice: true, appearances: [] },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const strip = (over: Partial<Parameters<typeof HeadStrip>[0]> = {}) =>
  render(<HeadStrip roster={ROSTER} current="si" pending={null} offline={false} importing={false} onPick={noop} bare={false} onBare={noop} {...over} />);

describe('head strip', () => {
  it('closes the roster on Escape', async () => {
    strip();
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /^切换角色/ })));
    expect(screen.getByRole('dialog', { name: '全部角色' })).toBeTruthy();
    await act(async () => void fireEvent.keyDown(document, { key: 'Escape' }));
    expect(screen.queryByRole('dialog', { name: '全部角色' })).toBeNull();
  });

  it('says 角色未运行 on a head it cannot switch to while she is not running', () => {
    strip({ offline: true });
    expect(within(screen.getByRole('group', { name: '角色头像' })).getByRole('button', { name: '示例甲' }).getAttribute('title')).toBe('角色未运行');
  });
});

describe('rename dialog', () => {
  it('does not save on the Enter that ends an IME composition', () => {
    const rename = vi.fn();
    const library = { rename, remove: noop, busy: false } as unknown as MotionLibrary;
    render(<MotionEditDialog edit={{ kind: 'rename', id: 'm', title: 'shi' }} removeNote="" onEdit={noop} library={library} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true });
    expect(rename).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(rename).toHaveBeenCalledWith('m', 'shi');
  });
});

const props: OperatorProps = {
  roster: ROSTER,
  current: 'si',
  sw: { state: { phase: 'idle' }, request: noop, retry: noop, dismiss: noop },
  offline: false,
  backoff: null,
  onRestart: noop,
  actions: MOTIONS,
  motionsError: null,
  onRetryMotions: noop,
  charState: null,
  toast: noop,
  pane: 'motion',
};

describe('operator', () => {
  it('opens on a motion the table shows when the first playable action is an MMD dance', () => {
    const dance: AvatarAction = { id: 'mmd_a', label: '舞蹈甲', enabled: true, section: 'talk', durationS: 12, playable: true };
    const { container } = render(<Operator {...props} actions={[dance, ...MOTIONS]} />);
    expect(container.querySelector('[data-motion][aria-selected="true"]')?.getAttribute('data-motion')).toBe('nod');
  });

  it('opens 动作表 for ?pane=chain without 编排', () => {
    render(<Operator {...props} pane="chain" />);
    expect(screen.getByRole('tabpanel', { name: '动作表' })).toBeTruthy();
  });

  it('has no 模组设置 for an appearance whose id is an Object member', () => {
    render(<Operator {...props} pane="look" roster={[{ ...ROSTER[0]!, appearances: [{ id: 'constructor', name: '构造', desc: '', kind: 'imported' }] }]} />);
    expect(screen.queryByRole('tab', { name: /模组设置/ })).toBeNull();
  });
});

describe('switch confirm', () => {
  it('asks only about the head clicked last when an earlier task read answers later', async () => {
    const reads: Array<(t: Array<{ title: string }>) => void> = [];
    const ask = vi.fn();
    const { result } = renderHook(() => useSwitch({ initial: { phase: 'idle' }, runningTasks: () => new Promise((r) => reads.push(r)), ask, onDone: noop }));
    act(() => result.current.request(ROSTER[1]!, 'si'));
    act(() => result.current.request(ROSTER[2]!, 'si'));
    await act(async () => reads[1]!([]));
    await act(async () => reads[0]!([]));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[0].title).toBe('切换至 示例丙？');
  });
});
