import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PowerState } from '../../src/ui/game';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

const content = (
  <div>
    <p>之前的对话</p>
    <button type="button">发送</button>
  </div>
);

describe('PowerState: page', () => {
  it('keeps the content on screen but inert, and puts a status board over it', () => {
    render(
      <PowerState state="off" mode="page" title="AI 对话" reason="设置里关掉了" action={{ label: '前往设置打开', onClick: () => {} }}>
        {content}
      </PowerState>,
    );
    const board = screen.getByRole('status');
    expect(board.textContent).toContain('已关闭');
    expect(board.textContent).toContain('AI 对话');
    expect(board.textContent).toContain('设置里关掉了');
    const inner = screen.getByText('之前的对话');
    expect(inner.closest('[inert]')).not.toBeNull();
    expect(board.closest('[inert]')).toBeNull();
  });

  it("runs the action's onClick from the board's button", () => {
    const go = vi.fn();
    render(
      <PowerState state="off" mode="page" title="AI 对话" reason="设置里关掉了" action={{ label: '前往设置打开', onClick: go }}>
        {content}
      </PowerState>,
    );
    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: /前往设置打开/ }));
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('says 未接入 with the plug for a service that is not connected', () => {
    const { container } = render(
      <PowerState state="unlinked" mode="page" title="模型" reason="没有账号" action={{ label: '前往设置连接', onClick: () => {} }}>
        {content}
      </PowerState>,
    );
    expect(screen.getByRole('status').textContent).toContain('未接入');
    expect(container.querySelector('[data-shape="plug"]')).not.toBeNull();
  });
});

describe('PowerState: block', () => {
  it('puts a status strip on top and dims the block, which stays usable', () => {
    render(
      <PowerState state="unlinked" mode="block" title="没有可用的模型" reason="登录后再发" action={{ label: '前往设置连接', onClick: () => {} }} more={<button type="button">重新检测</button>}>
        {content}
      </PowerState>,
    );
    const strip = screen.getByRole('status');
    expect(strip.textContent).toContain('未接入');
    expect(within(strip).getByRole('button', { name: '重新检测' })).toBeTruthy();
    expect(within(strip).getByRole('button', { name: /前往设置连接/ })).toBeTruthy();
    const inner = screen.getByText('之前的对话');
    expect(inner.closest('[inert]')).toBeNull();
    expect(inner.closest('[data-dim]')).not.toBeNull();
  });

  it('draws the off state with the crossed ring', () => {
    const { container } = render(
      <PowerState state="off" mode="block" title="屏幕识读" reason="关着" action={{ label: '前往设置打开', onClick: () => {} }}>
        {content}
      </PowerState>,
    );
    expect(screen.getByRole('status').textContent).toContain('已关闭');
    expect(container.querySelector('[data-shape="off"]')).not.toBeNull();
  });
});
