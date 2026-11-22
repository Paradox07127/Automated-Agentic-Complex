// 角色区框架：头像条和名字块只在总览；面板宽度按页分档；总览的语音一行读 agentd 的绑定；未运行和切换失败写在名字块下、舞台之外；黄色斜块只做装饰。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readVoiceBinding } from '../../src/bridge/agentd';
import { createFakeBridge } from '../../src/bridge/fake';
import { MOTIONS } from '../../src/mock/character';
import type { MockRoute } from '../../src/mock/types';
import { Operator, type OperatorProps } from '../../src/pages/character/Operator';

const noop = () => {};

/** agentd's GET /characters/:id/binding: `si` speaks with her package voice, `voice_a` has none, others are unknown. */
const BINDING: MockRoute = {
  method: 'GET',
  path: '/characters/:character_id/binding',
  handler: ({ params }) => {
    const id = params.character_id ?? '';
    if (id === 'si') return { status: 200, body: { character_id: id, revision: 0, voice: { voice_id: 'si', language: 'zh', source: 'package' } } };
    if (id === 'voice_a') return { status: 200, body: { character_id: id, revision: 0, voice: null } };
    return { status: 404, body: { error: 'unknown_character' } };
  },
};

const props: OperatorProps = {
  roster: [
    { id: 'si', name: '示例乙', en: 'SI', active: true, appearances: [] },
    { id: 'voice_a', name: '示例甲', en: 'VOICE_A', active: false, appearances: [] },
  ],
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
  pane: 'overview',
};

const op = () => document.querySelector('[data-view="operator"]') as HTMLElement;
const stageRect = () => document.querySelector('[data-preview-stage]') as HTMLElement;

beforeEach(() => {
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true, routes: [BINDING] });
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('readVoiceBinding', () => {
  it('keeps the voice id and language of the binding, and null without a voice', async () => {
    expect(await readVoiceBinding('si')).toEqual({ voiceId: 'si', language: 'zh' });
    expect(await readVoiceBinding('voice_a')).toBeNull();
    await expect(readVoiceBinding('cedar')).rejects.toMatchObject({ status: 404 });
  });
});

describe('总览', () => {
  it('has the head strip, the name block with 在桌面 and her voice, and the brand block', async () => {
    render(<Operator {...props} />);
    expect(screen.getByRole('group', { name: '角色头像' })).toBeTruthy();
    const plate = document.querySelector('[data-nameplate]') as HTMLElement;
    expect(plate.textContent).toContain('示例乙');
    expect(plate.textContent).toContain('在桌面');
    const voice = await within(plate).findByTitle('语音绑定');
    expect(voice.textContent).toBe('siZH');
    const brand = document.querySelector('[data-g="detail"]') as HTMLElement;
    expect(brand.getAttribute('aria-hidden')).toBe('true');
    expect(within(brand).queryAllByRole('button', { hidden: true })).toEqual([]);
    expect(op().hasAttribute('data-panel')).toBe(false);
  });

  it('draws no voice line for a character without one, nor 在桌面 for one not on the desktop', async () => {
    const read = vi.spyOn(window.agenticComplex!.agentd, 'request');
    render(<Operator {...props} current="voice_a" />);
    await waitFor(() => expect(read).toHaveBeenCalledWith('GET', '/characters/voice_a/binding', undefined));
    const plate = document.querySelector('[data-nameplate]') as HTMLElement;
    await act(async () => {});
    expect(within(plate).queryByTitle('语音绑定')).toBeNull();
    expect(plate.textContent).not.toContain('在桌面');
  });

  it('says she is not running under the name block, with 重启角色 outside the stage', async () => {
    const restart = vi.fn();
    render(<Operator {...props} offline backoff={8} onRestart={restart} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('角色未运行');
    expect(status.textContent).toContain('退避 8 秒后重试');
    expect(stageRect().contains(status)).toBe(false);
    expect(within(stageRect()).queryAllByRole('button')).toEqual([]);
    fireEvent.click(within(status).getByRole('button', { name: '重启角色' }));
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('says where a failed switch stopped, with 重试 and 关闭 outside the stage', () => {
    const retry = vi.fn();
    const dismiss = vi.fn();
    const target = props.roster[1]!;
    render(<Operator {...props} sw={{ state: { phase: 'failed', target, stage: 1, reason: '加载资源超时' }, request: noop, retry, dismiss }} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('切换到 示例甲 没有完成');
    expect(alert.textContent).toContain('仍是 示例乙');
    expect(alert.textContent).toContain('加载资源超时');
    expect(alert.textContent).toContain('加载资源，停在这里');
    expect(stageRect().contains(alert)).toBe(false);
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    fireEvent.click(within(alert).getByRole('button', { name: '关闭' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('says a switch is running without buttons', () => {
    render(<Operator {...props} sw={{ state: { phase: 'running', target: props.roster[1]! }, request: noop, retry: noop, dismiss: noop }} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('正在切换到 示例甲');
    expect(within(status).queryAllByRole('button')).toEqual([]);
  });
});

describe('detail pages', () => {
  it('have no head strip, name block or brand block, and take their panel width tier from the page', async () => {
    const cases: Array<[Partial<OperatorProps>, string]> = [
      [{ pane: 'motion' }, 'wide'],
      [{ pane: 'look' }, 'wide'],
      [{ pane: 'import' }, 'wide'],
      [{ side: { of: 'set', tab: 'behavior', tabs: ['behavior'], node: <div /> } }, 'narrow'],
      [{ side: { of: 'photo', node: <div /> } }, 'photo'],
    ];
    for (const [over, tier] of cases) {
      // 设定's tab bar reads the settings for its change dots.
      render(
        <QueryClientProvider client={new QueryClient()}>
          <Operator {...props} {...over} />
        </QueryClientProvider>,
      );
      expect(op().getAttribute('data-panel')).toBe(tier);
      expect(screen.queryByRole('group', { name: '角色头像' })).toBeNull();
      expect(document.querySelector('[data-nameplate]')).toBeNull();
      expect(document.querySelector('[data-g="detail"][aria-hidden="true"]')).toBeNull();
      cleanup();
    }
  });

  it('keep the not-running overlay on the stage', () => {
    render(<Operator {...props} pane="motion" offline />);
    const [overlay, slot] = screen.getAllByRole('status');
    expect(stageRect().contains(overlay!)).toBe(true);
    expect(overlay!.textContent).toContain('重启角色');
    // The slot under the stage says why 桌面预览 is off, outside the rect the live preview covers.
    expect(stageRect().contains(slot!)).toBe(false);
    expect(slot!.textContent).toBe('角色未运行');
  });
});
