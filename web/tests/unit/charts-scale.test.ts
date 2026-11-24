import { describe, expect, it } from 'vitest';
import { clockTickLabel, fraction, linePath, logPos, niceStep, niceTicks, offsetTickLabel, offsetTicks, timeStep, timeTicks, usageLevel } from '../../src/charts/scale';
import { meterLevel } from '../../src/charts/BracketMeter';
import { barListRows } from '../../src/charts/BarList';
import { chainStates } from '../../src/charts/NodeChain';
import { hourlyFailures } from '../../src/charts/DotStrip';

const at = (h: number, m: number) => new Date(2026, 9, 29, h, m).getTime();
const isNice = (step: number) => {
  const m = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
  return [1, 2, 5].some((k) => Math.abs(m - k) < 1e-9);
};

describe('tick calculation', () => {
  it('picks 1/2/5 steps with at most 6 ticks', () => {
    for (const span of [0.7, 1, 3, 7, 10, 42, 60, 99, 250, 1234, 98_765]) {
      const step = niceStep(span);
      expect(isNice(step), `${span} → ${step}`).toBe(true);
      expect(Math.floor(span / step) + 1).toBeLessThanOrEqual(6);
    }
    expect(niceStep(60)).toBe(20);
    expect(niceStep(100)).toBe(20);
  });

  it('puts ticks on step multiples inside the range', () => {
    expect(niceTicks(0, 100)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(-0.6, 0.6)).toEqual([-0.5, 0, 0.5]);
    expect(niceTicks(0, 1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    const t = niceTicks(3, 47);
    expect(t.length).toBeLessThanOrEqual(6);
    for (const v of t) expect(v >= 3 && v <= 47).toBe(true);
  });

  it('aligns time ticks to local clock steps', () => {
    const ticks = timeTicks(at(8, 0), at(15, 0));
    expect(ticks.length).toBeLessThanOrEqual(6);
    expect(ticks.map((t) => clockTickLabel(t, timeStep(at(15, 0) - at(8, 0))))).toEqual(['08:00', '10:00', '12:00', '14:00']);
    for (const t of ticks) expect(new Date(t).getMinutes()).toBe(0);
    const day = timeTicks(at(0, 0), at(14, 32));
    expect(day.length).toBeLessThanOrEqual(6);
    expect(day.every((t) => t >= at(0, 0) && t <= at(14, 32))).toBe(true);
  });

  it('labels relative axes in ms/s under a minute and mm:ss above', () => {
    expect(offsetTicks(3100)).toEqual([0, 1000, 2000, 3000]);
    expect(offsetTickLabel(0, 3100)).toBe('0 ms');
    expect(offsetTickLabel(1000, 3100)).toBe('1.0 s');
    expect(offsetTickLabel(120_000, 180_000)).toBe('02:00');
    expect(offsetTicks(180_000).length).toBeLessThanOrEqual(6);
  });

  it('maps durations on the log axis and clamps outside 100 ms – 1 min', () => {
    expect(logPos(100)).toBe(0);
    expect(logPos(60_000)).toBe(1);
    expect(logPos(10)).toBe(0);
    expect(logPos(10 ** 6)).toBe(1);
    expect(logPos(1000)).toBeGreaterThan(logPos(900));
  });

  it('paints an isolated value of a broken line as a zero-length dot', () => {
    expect(linePath([1, null, 5, null, 9], (i) => i, (v) => v)).toBe('M0.0 1.0h0M2.0 5.0h0M4.0 9.0h0');
    expect(linePath([1, 2, null, 4], (i) => i, (v) => v)).toBe('M0.0 1.0L1.0 2.0M3.0 4.0h0');
    expect(linePath([1, null, 3], (i) => i, (v) => v, true)).toBe('M0.0 1.0h0M2.0 3.0h0');
  });

  it('clamps fractions at 0 and 1', () => {
    expect(fraction(0, 200)).toBe(0);
    expect(fraction(231, 200)).toBe(1);
    expect(fraction(-5, 200)).toBe(0);
    expect(fraction(5, 0)).toBe(0);
  });
});

describe('threshold colouring', () => {
  it('uses <70 % ok, 70–90 % high, ≥90 % over', () => {
    expect(usageLevel(0, 200)).toBe('ok');
    expect(usageLevel(139, 200)).toBe('ok');
    expect(usageLevel(140, 200)).toBe('high');
    expect(usageLevel(179, 200)).toBe('high');
    expect(usageLevel(180, 200)).toBe('over');
    expect(usageLevel(231, 200)).toBe('over');
    expect(usageLevel(3, 0)).toBe('ok');
  });

  it('keeps state quantities on the series colour and negatives on s2', () => {
    expect(meterLevel(0.31, 1, 'level')).toBe('level');
    expect(meterLevel(-0.12, 1, 'level')).toBe('negative');
    expect(meterLevel(-1, 10, 'usage')).toBe('negative');
    expect(meterLevel(10, 12, 'usage')).toBe('high');
  });
});

describe('derived chart data', () => {
  it('merges everything after top N into 其他', () => {
    const rows = barListRows([{ key: 'a', label: 'A', value: 1 }, { key: 'b', label: 'B', value: 9 }, { key: 'c', label: 'C', value: 4 }, { key: 'd', label: 'D', value: 2 }], 2);
    expect(rows.map((r) => [r.label, r.value])).toEqual([['B', 9], ['C', 4], ['其他', 3]]);
  });

  it('marks every node after a break unreachable', () => {
    expect(chainStates([{ state: 'done' }, { state: 'broken' }, { state: 'todo' }, { state: 'done' }])).toEqual(['done', 'broken', 'unreachable', 'unreachable']);
  });

  it('counts failures per hour from the dots when no series is given', () => {
    const dots = [
      { id: 'a', started_at: at(0, 10), duration_ms: 500, result: 'failed' as const, source: 'x' },
      { id: 'b', started_at: at(2, 30), duration_ms: 500, result: 'failed' as const, source: 'x' },
      { id: 'c', started_at: at(2, 40), duration_ms: 500, result: 'ok' as const, source: 'x' },
    ];
    expect(hourlyFailures(dots, at(0, 0), at(3, 0))).toEqual([1, 0, 1]);
    expect(hourlyFailures(dots, at(0, 0), at(3, 0), [0, 0, 5])).toEqual([0, 0, 5]);
  });
});
