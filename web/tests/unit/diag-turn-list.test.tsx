// Each row of 诊断's 按列表查看轮次 list names its turn for a screen reader.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { formatClock, type Turn } from '../../src/domain';
import { TurnsSection } from '../../src/pages/diag/TurnsSection';

afterEach(cleanup);

const T0 = new Date(2026, 10, 21, 10, 45, 12).getTime();
const turn = (id: string, over: Partial<Turn>): Turn => ({ id, turn_id: id, started_at: T0, source: 'proactive', result: 'ok', duration_ms: 1700, stages: [], marks: [], ...over });

it('each list row button carries an aria-label of its time, source, result and duration; a head cut short of len ends in …', () => {
  const turns = [
    turn('a', {}),
    turn('b', { source: 'text', head: '帮我看下报错', len: 6, result: 'failed', duration_ms: 900, started_at: T0 + 60_000 }),
    turn('c', { source: 'text', head: '帮我整理这周的提', len: 28, started_at: T0 + 120_000 }),
  ];
  render(
    <TurnsSection
      turns={turns} start={T0 - 3_600_000} end={T0 + 3_600_000} range="24h" setRange={() => {}} st="ok" truncated={false}
      sel={null} onPick={() => {}} node={null} onClearNode={() => {}} trace={null} traceSt="ok" onRecords={null} onChat={null} onRetry={() => {}}
    />,
  );
  const rows = screen.getAllByRole('button', { hidden: true }).filter((b) => b.hasAttribute('aria-pressed') && b.closest('details'));
  expect(rows.map((b) => b.getAttribute('aria-label'))).toEqual([
    `${formatClock(T0, { seconds: true })} 主动发言 成功 1.7 s`,
    `${formatClock(T0 + 60_000, { seconds: true })} 对话 │ 帮我看下报错 失败 900 ms`,
    `${formatClock(T0 + 120_000, { seconds: true })} 对话 │ 帮我整理这周的提… 成功 1.7 s`,
  ]);
  expect(rows[2]!.textContent).toContain('帮我整理这周的提…');
});
