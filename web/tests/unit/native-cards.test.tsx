import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { stackScenario } from '../../src/mock/stack';
import { orderCards, priorityOf, visibleCards, type DesktopStackCard, type StackCard } from '../../src/surfaces/stack/model';
import { StackCardView } from '../../src/surfaces/stack/StackCardView';
import { stubMatchMedia } from './mediaStub';

// The notices native raises itself (电脑操作, 语音提示, 角色加载) and the 屏幕识读 receipt.

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function card<V extends DesktopStackCard['variant']>(scenario: string, variant: V): Extract<DesktopStackCard, { variant: V }> {
  const c = stackScenario(scenario).cards.find((x) => x.kind === 'notice' && x.variant === variant);
  if (!c) throw new Error(`no ${variant} in ${scenario}`);
  return c as Extract<DesktopStackCard, { variant: V }>;
}

const voice = (phase: Extract<DesktopStackCard, { variant: 'voice' }>['phase']): StackCard => ({ ...card('desktop', 'voice'), phase });

describe('priority and order', () => {
  it('puts 电脑操作 (P0) above every pending card, 角色加载 at P2 and 语音提示 at P3', () => {
    const computer = card('desktop', 'computer');
    expect(priorityOf(computer)).toBe(0);
    expect(priorityOf(card('desktop-progress', 'loading'))).toBe(2);
    expect(priorityOf(card('desktop', 'voice'))).toBe(3);
    const ordered = orderCards(stackScenario('desktop').cards);
    expect(ordered.map((c) => c.id)).toEqual(['computer-use', expect.any(String), 'voice-hint']);
    expect(ordered[1]?.kind).toBe('approval');
    // The resident P0 stays on screen even with more than three open cards.
    const many = orderCards([...stackScenario('default').cards, computer]);
    expect(visibleCards(many, false)[0]?.id).toBe('computer-use');
  });

  it('orders the other notices by priority, newest first', () => {
    const ordered = orderCards(stackScenario('desktop-progress').cards);
    expect(ordered.map((c) => c.kind === 'notice' && c.variant)).toEqual(['loading', 'voice', 'look']);
  });
});

describe('cards', () => {
  it('电脑操作: 收起 folds through the stack and 停止 stops computer use', async () => {
    const stop = vi.spyOn(getBridge().computerUse, 'stop').mockResolvedValue();
    const act = vi.fn();
    render(<StackCardView card={card('desktop', 'computer')} index={1} total={1} top now={0} act={act} />);
    screen.getByText('正在操作「访达」');
    expect(screen.getByRole('button', { name: /窗口与范围/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('下载文件夹')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(act).toHaveBeenLastCalledWith({ type: 'collapse', id: 'computer-use' });
    fireEvent.click(screen.getByRole('button', { name: /停止/ }));
    expect(stop).toHaveBeenCalledTimes(1);
    await waitFor(() => screen.getByRole('button', { name: /已停止/ }));
  });

  it('角色加载失败: 重新启动 restarts the avatar and 关闭 archives', async () => {
    const restart = vi.spyOn(getBridge().supervisor, 'restart').mockResolvedValue();
    const act = vi.fn();
    render(<StackCardView card={card('desktop-progress', 'loading')} index={1} total={1} top now={0} act={act} />);
    fireEvent.click(screen.getByRole('button', { name: /重新启动/ }));
    expect(restart).toHaveBeenCalledWith('avatar');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(act).toHaveBeenLastCalledWith({ type: 'archive', id: 'avatar-loading' });
  });

  it('角色恢复中 counts down to the retry', () => {
    const c = stackScenario('desktop-recovering').cards[0]!;
    render(<StackCardView card={c} index={1} total={1} top now={(c as { retry_at: number }).retry_at - 3_000} act={() => {}} />);
    screen.getByText('3 秒后重试');
  });

  it('麦克风被拒 stays until closed and only it has a close button', () => {
    const act = vi.fn();
    render(<StackCardView card={card('desktop', 'voice')} index={1} total={1} top now={0} act={act} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(act).toHaveBeenLastCalledWith({ type: 'archive', id: 'voice-hint' });
    cleanup();
    render(<StackCardView card={voice('sent')} index={1} total={1} top now={0} act={act} />);
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
  });
});
