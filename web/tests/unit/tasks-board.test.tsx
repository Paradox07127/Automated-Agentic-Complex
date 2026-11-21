// 任务看板模型：卡片合并与排序、甘特行（今天页的任务卡回退沿用）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOW } from '../../src/mock/fixtures';
import { S_3C77, S_41B0, T1 } from '../../src/mock/fixtures/ids';
import { buildCards, ganttRow, loadBoard, sortCards } from '../../src/pages/tasks/board';
import { deriveView, emptyLocal } from '../../src/pages/tasks/model';
import { loadTasksBase } from '../../src/pages/tasks/useTasksData';

afterEach(() => {
  delete window.agenticComplex;
  vi.restoreAllMocks();
  localStorage.clear();
});

const uuid = (s: string) => s.slice(s.indexOf(':') + 1);

describe('tasks: board model', () => {
  it('one card per task of today plus ledger sessions no task covers; waiting and failed first', async () => {
    const [base, board] = await Promise.all([loadTasksBase(false), loadBoard(NOW)]);
    const list = sortCards(buildCards(deriveView(base, emptyLocal()), board, NOW));
    const ids = list.map((c) => c.id);
    expect(ids).toContain(`ses:${uuid(S_41B0)}`);
    expect(ids).toContain(`ses:${uuid(S_3C77)}`);
    expect(ids).not.toContain('task:7e3a9c1b5d2f8a47');
    const order = list.map((c) => c.status);
    expect(order.indexOf('err')).toBeGreaterThan(order.lastIndexOf('wait'));
    expect(order.lastIndexOf('err')).toBeLessThan(order.indexOf('tool'));
    // The ledger's last gate failed for this session; that alone does not make it 出错.
    expect(board.sessions.find((s) => s.key === uuid(S_41B0))?.gate?.passed).toBe(false);
    expect(list.find((c) => c.id === `ses:${uuid(S_41B0)}`)?.status).not.toBe('err');
  });

  it('gate marks stay off the main chart; the detail keeps a failed gate and blocks, never a passed gate', async () => {
    const [base, board] = await Promise.all([loadTasksBase(false), loadBoard(NOW)]);
    const ses = buildCards(deriveView(base, emptyLocal()), board, NOW).find((c) => c.id === `ses:${uuid(S_41B0)}`)!;
    expect(ganttRow(ses, undefined, true).marks).toEqual([]);
    expect(ganttRow(ses, undefined, false).marks?.map((m) => m.kind)).toEqual(['gate-fail']);
    const history = { segs: [[NOW - 60_000, 'tool']] as Array<[number, 'tool']>, marks: [{ t: NOW - 30_000, kind: 'block' as const, label: '拦截' }, { t: NOW - 20_000, kind: 'gate-fail' as const, label: '失败' }] };
    expect(ganttRow(ses, history, true).marks).toEqual([]);
    expect(ganttRow(ses, history, false).marks?.map((m) => m.kind)).toEqual(['block', 'gate-fail']);
    expect(ganttRow({ ...ses, gate: { at: NOW, passed: true } }, undefined, false).marks).toEqual([]);
  });

  it('without the history agentd does not send yet a live card is one bar until its wait, which starts with ◆', async () => {
    const [base, board] = await Promise.all([loadTasksBase(false), loadBoard(NOW)]);
    const t1 = buildCards(deriveView(base, emptyLocal()), board, NOW).find((c) => c.id === T1)!;
    const row = ganttRow(t1, undefined, true);
    expect(row.segs.map((s) => s.state)).toEqual(['live', 'review']);
    expect(row.segs.at(-1)?.t1).toBeNull();
    expect(row.marks?.map((m) => m.kind)).toEqual(['diamond']);
    const done = ganttRow({ ...t1, status: 'done', last: NOW, gate: { at: NOW, passed: true } }, undefined, true);
    expect(done.marks).toEqual([]);
  });
});
