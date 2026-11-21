import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Health } from '../../src/domain';
import { HealthChain } from '../../src/features/health';
import { healthOf, NOW } from '../../src/mock/fixtures';

afterEach(cleanup);

const withVoice = (state: Health['voice']['state'], retryAfterS: number | null = null): Health => ({ ...healthOf(), voice: { state, retryAfterS } });
const voiceNode = () => document.querySelector('[aria-label^="语音："]');

describe('HealthChain voice node', () => {
  it.each([
    ['unknown', '未检测'],
    ['probing', '检测中'],
    ['cold', '冷启动（第一句会慢）'],
  ] as const)('%s is neutral: no ✕ and not in the problem list', (state, sub) => {
    render(<HealthChain health={withVoice(state)} now={NOW} onNode={() => {}} />);
    const node = voiceNode();
    expect(node?.getAttribute('data-st')).toBe('idle');
    expect(node?.getAttribute('aria-label')).toContain(sub);
    expect(node?.textContent).not.toContain('✕');
    expect(screen.queryByRole('button', { name: '重新连接' })).toBeNull();
    expect(document.body.textContent).toContain('✓ 全部在线');
  });

  it('unreachable is broken, listed with the seconds until a retry, and its fix resets the voice', () => {
    const onNode = vi.fn();
    const onVoiceReset = vi.fn();
    render(<HealthChain health={withVoice('unreachable', 30)} now={NOW} onNode={onNode} onVoiceReset={onVoiceReset} />);
    expect(voiceNode()?.getAttribute('data-st')).toBe('broken');
    expect(document.body.textContent).toContain('✕ 语音远端不通 │ 30 秒后可重试');
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
    expect(onVoiceReset).toHaveBeenCalledTimes(1);
    expect(onNode).not.toHaveBeenCalled();
  });

  it('ready is done; off is neutral and not a problem (the release has no voice)', () => {
    render(<HealthChain health={withVoice('ready')} now={NOW} />);
    expect(voiceNode()?.getAttribute('data-st')).toBe('done');
    expect(voiceNode()?.getAttribute('aria-label')).toBe('语音：在线，在线');
    cleanup();
    render(<HealthChain health={withVoice('off')} now={NOW} />);
    expect(voiceNode()?.getAttribute('data-st')).toBe('idle');
    expect(screen.queryByRole('button', { name: '重新连接' })).toBeNull();
    expect(voiceNode()?.getAttribute('aria-label')).toContain('已关闭');
  });
});
