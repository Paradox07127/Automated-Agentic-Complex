import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer, type ComposerProps } from '../../src/pages/chat/Composer';
import { TextMessage } from '../../src/pages/chat/TextMessage';

afterEach(cleanup);

const composer: ComposerProps = {
  roleName: '她', history: false, busy: false, kernel: null, alternative: null, failed: null, sending: false,
  onSend: vi.fn(), onResend: vi.fn(), onDiscardFailed: vi.fn(), onContinue: vi.fn(),
  onRecheck: vi.fn(), onCopy: vi.fn(), onSwitchKernel: vi.fn(),
};

describe('turn model identity', () => {
  it.each([['codex_login', 'codex_login', 'Codex 登录'], ['claude_login', 'claude_login', 'Claude 登录'], ['deepseek', 'deepseek_api', 'DeepSeek API']])('renders %s under her reply', (provider, account, label) => {
    render(<TextMessage mine={false} at={0} text="好。" roleName="她" turn={{ no: 1, res: '成功', ms: 1, provider, account_label: account }} />);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it('shows the no-model banner with a link to model settings', () => {
    render(<Composer {...composer} modelError="missing_api_key" />);
    expect(screen.getByRole('alert').textContent).toContain('没有可用的模型：登录 Claude Code 或 Codex，或在 设置 › pi 账号与凭据 填一个 API key');
    expect(screen.getByRole('link', { name: '设置 › pi 账号与凭据' }).getAttribute('href')).toBe('#/settings?group=model');
  });
});
