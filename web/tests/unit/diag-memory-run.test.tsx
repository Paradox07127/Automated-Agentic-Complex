// Diag: memory run detail, capability codes in Chinese, the last unspoken line, native deep links.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, HttpMethod } from '../../src/bridge/protocol';
import { isoWithOffset } from '../../src/domain/units';
import { NOW } from '../../src/mock/fixtures';
import { DIAG_STATE } from '../../src/mock/diag';
import { NowPanel } from '../../src/pages/diag/NowPanel';
import { DiagPage } from '../../src/pages/diag/Page';
import { issuesOf } from '../../src/pages/diag/status';

let calls: Array<[HttpMethod, string]>;

function install() {
  const fake = createFakeBridge({ surface: 'main', still: true });
  const bridge: AgenticComplexBridge = {
    ...fake,
    agentd: { ...fake.agentd, request: (m, p, b) => (calls.push([m, p]), fake.agentd.request(m, p, b)) },
    diag: { subscribe: () => () => {} },
  };
  window.agenticComplex = bridge;
}

async function mount(search: string) {
  const root = createRootRoute({ component: DiagPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const paths = () => calls.map(([m, p]) => `${m} ${p}`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  calls = [];
  install();
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.useRealTimers();
});

describe('diag › memory run detail', () => {

  it('a run link (fact sheet) opens that run straight away', async () => {
    await mount('&kind=memory&run=mrun-00');
    expect(await screen.findByRole('dialog', { name: '记忆生成记录' })).toBeTruthy();
    expect(paths()).toContain('GET /memory/runs/mrun-00');
  });

  it('says a cleared run detail in Chinese', async () => {
    await mount('&kind=memory&run=mrun-03');
    const sheet = await screen.findByRole('dialog', { name: '记忆生成记录' });
    expect(await within(sheet).findByText(/详细内容已清理/)).toBeTruthy();
    expect(sheet.textContent).not.toContain('expired');
  });

  it('a task run link (run= without kind=memory) opens no memory run', async () => {
    await mount('&tab=timeline&run=run-9c1e');
    await waitFor(() => expect(paths()).toContain('GET /diag/state'));
    expect(screen.queryByRole('dialog', { name: '记忆生成记录' })).toBeNull();
    expect(paths().filter((p) => p.startsWith('GET /memory/runs/'))).toEqual([]);
  });
});

describe('diag › native deep links keep their target', () => {
  it('trace= opens that turn and reads its events', async () => {
    await mount('&trace=tr2');
    await waitFor(() => expect(paths()).toContain('GET /trace/turns/tr2'));
    expect(await screen.findByText('轮次详情')).toBeTruthy();
  });
});

describe('diag › codes in Chinese', () => {
  it('maps runtime and unknown capability reasons, keeping the code aside', () => {
    const issues = issuesOf({
      plugins: {},
      at: isoWithOffset(NOW),
      items: {
        personal_agent: { state: 'unavailable', reason: 'native_login_required' },
        generation: { state: 'unavailable', reason: 'character_context_unavailable' },
        voice: { state: 'degraded', reason: 'brand_new_code' },
      },
    });
    for (const i of issues) expect(i.detail).not.toMatch(/[a-z]_[a-z]/);
    expect(issues.find((i) => i.id === 'generation')?.detail).toBe('角色资料没准备好');
    expect(issues.find((i) => i.id === 'voice')).toMatchObject({ detail: '其他原因', code: 'brand_new_code' });
    expect(issues.find((i) => i.id === 'personal_agent')?.detail).toBe('还没登录内核');
  });

  it('NowPanel shows why and when the last line was not spoken', () => {
    const d = { ...DIAG_STATE, mouth_voice: { ...DIAG_STATE.mouth_voice, speech_failed: { speech_id: 's1', reason: 'unreachable', at: isoWithOffset(NOW - 65_000) } } };
    render(<NowPanel d={d} />);
    expect(screen.getByText('上次没说出口')).toBeTruthy();
    expect(screen.getByText('14:31:05，语音合成失败：连不上')).toBeTruthy();
  });

  it('NowPanel names the body behavior and the running ones in Chinese', () => {
    const d = { ...DIAG_STATE, body: { ...DIAG_STATE.body, activity: 'relax' }, behavior: { ...DIAG_STATE.behavior, running: [{ behavior_id: 'b', type: 'sit', target: null, since: isoWithOffset(NOW) }] } };
    render(<NowPanel d={d} />);
    const body = screen.getByText(/放松/);
    expect(body.textContent).toContain('在做 坐着');
    expect(body.textContent).not.toMatch(/relax|sit/);
    expect(screen.getByText(/关注 写代码/)).toBeTruthy();
  });

  it('NowPanel shows her mood code as its Chinese word', () => {
    const d = { ...DIAG_STATE, character_state: { ...DIAG_STATE.character_state, labels: { energy: 'very_sleepy', mood: 'steady', engagement: 'some' } } };
    render(<NowPanel d={d} />);
    const body = screen.getByText(/平稳/);
    expect(body.textContent).not.toMatch(/steady/);
  });
});
