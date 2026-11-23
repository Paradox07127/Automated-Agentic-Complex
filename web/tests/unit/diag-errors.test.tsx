// 诊断 › 总览 › 错误: the shell's and agentd's error records (`logs.errors`), one row per component and code with its total,
// last time and last message, newest first; a row opens its records, and a record with a turn opens it in 对话轮次.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { ErrorRecordRow } from '../../src/bridge/logs';
import { DiagPage } from '../../src/pages/diag/Page';
import { pluginsOn, pluginsReset } from './plugins';

// Under a native-like bridge the page reads the wall clock: today's records show their time alone, older ones their date too.
const at = (h: number, m: number, daysAgo = 0) => new Date(Date.now() - daysAgo * 86_400_000).setHours(h, m, 0, 0);
const NO_IDS = { detail: null, turn_id: null, trace_id: null, req: null };
const RECORDS: ErrorRecordRow[] = [
  { ...NO_IDS, source: 'agentd', at: at(14, 5), component: 'agentd', code: 'timeout', message: 'text turn failed: TimeoutError', turn_id: 't2', trace_id: 'tr2', count: 1 },
  { ...NO_IDS, source: 'shell', at: at(13, 0), component: 'bridge', code: 'op_failed', message: 'logs.read not_implemented', req: 'logs.read', count: 3 },
  { ...NO_IDS, source: 'agentd', at: at(9, 30), component: 'agentd', code: 'timeout', message: 'voice turn failed: TimeoutError', turn_id: 't1', count: 2 },
  { ...NO_IDS, source: 'agentd', at: at(8, 0, 1), component: 'agentd', code: 'tts_token_missing', message: 'tts token missing', count: 1 },
];
const yesterday = new Date(at(8, 0, 1));
const md = `${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

function mount(records: ErrorRecordRow[]) {
  const fake = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = { ...fake, logs: { ...fake.logs, errors: async () => ({ records }) } };
  const root = createRootRoute({ component: DiagPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  pluginsOn();
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  pluginsReset();
  delete window.agenticComplex;
});

describe('诊断 › 总览 › 错误', () => {
  it('groups by component and code: total, last time and last message, newest group first', async () => {
    mount(RECORDS);
    const list = await screen.findByRole('list', { name: '错误' }, { timeout: 3000 });
    const groups = within(list).getAllByRole('button', { expanded: false });
    expect(groups.map((g) => g.textContent)).toEqual([
      'timeoutagentd×314:05text turn failed: TimeoutError',
      'op_failedbridge×313:00logs.read not_implemented',
      `tts_token_missingagentd×1${md} 08:00tts token missing`,
    ]);
  });

  it('a group opens its records, newest first; a record with a turn opens it in 对话轮次', async () => {
    mount(RECORDS);
    const list = await screen.findByRole('list', { name: '错误' }, { timeout: 3000 });
    fireEvent.click(within(list).getAllByRole('button', { expanded: false })[0]!);
    const rows = within(list).getByRole('list', { name: 'agentd │ timeout' });
    expect(within(rows).getAllByRole('listitem').map((r) => r.textContent)).toEqual([
      '14:05text turn failed: TimeoutError对话轮次 ›',
      '09:30×2voice turn failed: TimeoutError对话轮次 ›',
    ]);
    const [first, second] = within(rows).getAllByRole('button', { name: '对话轮次 ›' });
    fireEvent.click(first!);
    expect(window.location.hash).toBe('#/diag?tab=turns&turn=tr2');
    fireEvent.click(second!);
    expect(window.location.hash).toBe('#/diag?tab=turns&turn=t1');
  });

  it('says when there is no record', async () => {
    mount([]);
    expect(await screen.findByText('没有错误记录', {}, { timeout: 3000 })).toBeTruthy();
  });
});
