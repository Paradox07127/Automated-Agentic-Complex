import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputerUsePanel } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import { ComputerUseRoot } from '../../src/surfaces/desktop/ComputerUseRoot';

// `stack.html#/computer`: what each state shows and what each button asks native for.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

const WAITING: ComputerUsePanel = {
  phase: 'waitingPermission', targetApp: 'TextEdit', action: '请明确选择此窗口可用的权限；不选择就不会读取或操作。',
  scopeChips: ['窗口 640', '会话 s1', '10分钟'], permissions: {}, pendingGrants: [], showsPermissionChoices: true, canResume: false,
  challenge: 'c-1',
};

function mount() {
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  let push: (p: ComputerUsePanel) => void = () => {};
  vi.spyOn(bridge.computerUse, 'onPanel').mockImplementation((cb) => {
    push = cb;
    return () => {};
  });
  const calls = {
    grant: vi.spyOn(bridge.computerUse, 'grant'),
    revoke: vi.spyOn(bridge.computerUse, 'revoke'),
    resume: vi.spyOn(bridge.computerUse, 'resume'),
    dismiss: vi.spyOn(bridge.computerUse, 'dismiss'),
    stop: vi.spyOn(bridge.computerUse, 'stop'),
    size: vi.spyOn(bridge.window, 'setContentSize'),
  };
  window.agenticComplex = bridge;
  render(<ComputerUseRoot />);
  return { calls, show: (p: ComputerUsePanel) => act(() => push(p)) };
}

describe('the computer-use panel page', () => {
  it('shows the phase, the target, the action, the chips and a grant button per scope; a click asks native', () => {
    const { calls, show } = mount();
    expect(screen.queryByRole('heading')).toBeNull();
    show(WAITING);
    screen.getByRole('heading', { name: '等待你的选择' });
    screen.getByText('TextEdit');
    screen.getByText(WAITING.action);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(WAITING.scopeChips);
    expect(screen.getAllByRole('button', { name: /^允许/ }).map((b) => b.textContent)).toEqual([
      '允许观察控件未勾选', '允许读取文字未勾选', '允许查看截图未勾选', '允许执行操作未勾选']);
    screen.getByText('不会因打开此面板自动授权');
    screen.getByText('你可以随时停止');
    fireEvent.click(screen.getByRole('button', { name: /允许执行操作/ }));
    expect(calls.grant).toHaveBeenCalledWith(['control'], 'c-1');
    expect(calls.size).toHaveBeenCalled();
  });

  it('an allowed scope takes it back, a pending or unavailable one is text, and 继续, 停止, 收起 reach native', () => {
    const { calls, show } = mount();
    show({ ...WAITING, phase: 'paused', permissions: { observation: 'allowed', image: 'unavailable' }, pendingGrants: ['text'], canResume: true });
    screen.getByRole('heading', { name: '已暂停' });
    fireEvent.click(screen.getByRole('button', { name: '观察控件已勾选，点击取消授权' }));
    expect(calls.revoke).toHaveBeenCalledWith(['observation'], 'c-1');
    screen.getByText('正在确认');
    screen.getByText('不可用');
    expect(screen.queryByRole('button', { name: /读取文字|查看截图/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    fireEvent.click(screen.getByRole('button', { name: '收起电脑操作状态' }));
    expect([calls.resume, calls.stop, calls.dismiss].map((c) => c.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it('without a pending window there are no permission choices', () => {
    mount().show({ ...WAITING, phase: 'executing', showsPermissionChoices: false });
    screen.getByRole('heading', { name: '正在操作' });
    expect(screen.queryByRole('button', { name: /允许/ })).toBeNull();
    expect(screen.queryByText('均可选')).toBeNull();
  });
});
