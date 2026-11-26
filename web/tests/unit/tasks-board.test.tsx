// 任务看板模型：卡片合并与排序（今天页的任务卡回退沿用）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOW } from '../../src/mock/fixtures';
import { S_3C77, S_41B0 } from '../../src/mock/fixtures/ids';
import { buildCards, loadBoard, sortCards } from '../../src/pages/tasks/board';
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
    const [base, board] = await Promise.all([loadTasksBase(false, { sessions: true, agent: true }), loadBoard(NOW)]);
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
});
