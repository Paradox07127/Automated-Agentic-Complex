// 观察模型：应用排名与占比、按小时拆分、时间线范围、任务推断（今天页的时间线和活动汇总沿用）。
import { describe, expect, it } from 'vitest';
import { at, NOW } from '../../src/mock/fixtures';
import { OBS_SEGMENTS } from '../../src/mock/observe';
import { taskGuessOf } from '../../src/pages/observe/data';
import { hoursOf, rangeOf, rankFromSegments, rankFromSummary, shareOf } from '../../src/pages/observe/model';

describe('observe model', () => {
  it('ranks apps, lumps the rest into 其他 and keeps the share total', () => {
    const rank = rankFromSummary([
      { app: 'Terminal', seconds: 85 * 60 },
      { app: 'Xcode', seconds: 80 * 60 },
      { app: 'Safari', seconds: 45 * 60 },
      { app: '飞书', seconds: 30 * 60 },
      { app: '其他', seconds: 22 * 60 },
    ]);
    const share = shareOf(rank);
    expect(share.map((x) => [x.label, x.minutes])).toEqual([
      ['Terminal', 85],
      ['Xcode', 80],
      ['Safari', 45],
      ['其他', 52],
    ]);
    expect(share[3]?.sub).toBe('飞书');
  });

  it('splits foreground minutes by hour and ranges the timeline from 08:30 to 15:00', () => {
    const rank = rankFromSegments(OBS_SEGMENTS);
    const hours = hoursOf(OBS_SEGMENTS, rank, at(8, 0), at(15, 0));
    expect(hours.map((h) => h.label)).toEqual(['08', '09', '10', '11', '12', '13', '14']);
    const total = hours.reduce((n, h) => n + Object.values(h.parts).reduce((a, b) => a + b, 0), 0);
    expect(Math.abs(total - Object.values(rank.minutes).reduce((a, b) => a + b, 0))).toBeLessThanOrEqual(3);
    const ep = { id: '1', start: at(9, 2), end: at(9, 48), title: '', apps: [] };
    expect(rangeOf([ep], at(0, 0), NOW, true)).toEqual([at(8, 30), at(15, 0)]);
  });

  it('shows corrected and continuously observed hypotheses with their state and expiry', () => {
    const base = { id: 'hyp-1', revision: 2, created_at: 1, task: '在修 HostLink 断线重连' };
    expect(taskGuessOf({ available: true, reason: null, hypotheses: [{ ...base, state: 'corrected', expires_at: 4000 }] })).toEqual({ id: 'hyp-1', revision: 2, task: '在修 HostLink 断线重连', expiresAt: 4_000_000 });
    const observed = { id: 'hyp-2', revision: 1, state: 'active', created_at: 1, expires_at: 4000, task: '整理周报', goal: '未知', status: 'working' };
    expect(taskGuessOf({ available: true, reason: null, hypotheses: [observed] })).toEqual({ id: 'hyp-2', revision: 1, task: '整理周报', expiresAt: 4_000_000 });
    expect(taskGuessOf({ available: true, reason: null, hypotheses: [{ ...base, state: 'rejected', expires_at: 4000 }] })).toBeNull();
  });
});
