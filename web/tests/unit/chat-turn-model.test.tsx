import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer, type ComposerProps } from '../../src/pages/chat/Composer';
import { TextMessage } from '../../src/pages/chat/TextMessage';

afterEach(cleanup);

const composer: ComposerProps = {
  roleName: '她', history: false, busy: false, kernel: null, failed: null, sending: false,
  onSend: vi.fn(), onResend: vi.fn(), onDiscardFailed: vi.fn(), onContinue: vi.fn(),
  onRecheck: vi.fn(),
};

describe('turn model identity', () => {
  it('keeps the model and account out of her reply', () => {
    const { container } = render(<TextMessage mine={false} at={0} text="好。" roleName="她" />);
    expect(container.textContent).not.toMatch(/Codex 登录|Claude 登录|DeepSeek API/);
  });

  it('shows 未接入 over the input with a button to the model account row', () => {
    render(<Composer {...composer} modelError="missing_api_key" />);
    const strip = screen.getByRole('status');
    expect(strip.textContent).toContain('未接入');
    expect(strip.textContent).toContain('没有可用的模型');
    expect(strip.textContent).toContain('登录 Claude Code 或 Codex，或在设置里给 pi 填一个 API key');
    fireEvent.click(within(strip).getByRole('button', { name: /前往设置连接/ }));
    const q = new URLSearchParams(window.location.hash.slice(window.location.hash.indexOf('?') + 1));
    expect(q.get('group')).toBe('kernel');
    expect(q.get('item')).toBe('svc');
  });
});
