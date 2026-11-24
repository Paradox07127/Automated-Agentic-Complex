import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LineChart, type Pt } from '../../src/charts';

afterEach(cleanup);

const t0 = 1_000_000;
const t1 = t0 + 3_600_000;
const pts: Pt[] = Array.from({ length: 7 }, (_, i) => [t0 + i * 600_000, (i * 3) % 5]);

describe('LineChart event marks', () => {
  it('draws only the marks inside [t0, t1]', () => {
    const marks = [
      { t: t0 - 3_600_000, label: '任务出错' },
      { t: t0 + 1_800_000, label: '起床' },
      { t: t1 + 60_000, label: '之后' },
    ];
    const { container } = render(<LineChart label="状态" series={[{ id: 'e', label: '精神', pts }]} t0={t0} t1={t1} w={400} marks={marks} />);
    const texts = [...container.querySelectorAll('svg text')].map((t) => t.textContent);
    expect(texts).toContain('起床');
    expect(texts).not.toContain('任务出错');
    expect(texts).not.toContain('之后');
  });

  it('turns a label near the right edge inward', () => {
    const { container } = render(<LineChart label="状态" series={[{ id: 'e', label: '精神', pts }]} t0={t0} t1={t1} w={400} marks={[{ t: t1 - 30_000, label: '任务出错' }]} />);
    const t = [...container.querySelectorAll('svg text')].find((x) => x.textContent === '任务出错')!;
    expect(t.getAttribute('text-anchor')).toBe('end');
  });
});

describe('LineChart values', () => {
  const m = 60_000;
  const fmtT = (t: number) => String((t - t0) / m);
  const tableRows = (c: HTMLElement) => {
    fireEvent.click(c.querySelector('[data-table-toggle]') as Element);
    return [...c.querySelectorAll('[data-chart-table] tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent ?? ''));
  };

  it('builds table rows from every series’ timestamps', () => {
    const series = [
      { id: 'a', label: 'A', pts: [[t0, 1], [t0 + m, 2]] as Pt[] },
      { id: 'b', label: 'B', pts: [[t0 + 2 * m, 7]] as Pt[] },
    ];
    const { container } = render(<LineChart label="读数" series={series} w={400} fmtT={fmtT} />);
    expect(tableRows(container)).toEqual([['0', '1', '—'], ['1', '2', '—'], ['2', '—', '7']]);
    cleanup();
    const empty = render(<LineChart label="读数" series={[{ id: 'a', label: 'A', pts: [] }, series[1]!]} w={400} fmtT={fmtT} />);
    expect(tableRows(empty.container)).toEqual([['2', '—', '7']]);
  });

  it('reads every series at one shared time in the tooltip, — where a series has no value', () => {
    const series = [
      { id: 'a', label: 'A', pts: [[t0, 1], [t0 + m, 2]] as Pt[] },
      { id: 'b', label: 'B', pts: [[t0, 5], [t0 + m, null]] as Pt[] },
    ];
    const { container } = render(<LineChart label="读数" series={series} w={400} fmtT={fmtT} />);
    // w=400: the plot runs from x=34 to x=364, so 364 is the last time.
    fireEvent.mouseMove(container.querySelector('svg[role="img"]') as Element, { clientX: 364, clientY: 10 });
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe('1\nA  2\nB  —');
  });

  it('closes each run of the area to the baseline on its own', () => {
    const pts: Pt[] = [[t0, 1], [t0 + m, 2], [t0 + 2 * m, null], [t0 + 3 * m, 4], [t0 + 4 * m, 5]];
    const { container } = render(<LineChart label="读数" series={[{ id: 'a', label: 'A', pts }]} area yMin={0} w={400} />);
    const d = container.querySelector('path[opacity=".1"]')?.getAttribute('d') ?? '';
    const runs = d.split('M').filter(Boolean);
    expect(runs).toHaveLength(2);
    for (const r of runs) expect(r.endsWith('Z')).toBe(true);
  });

  it('clips the lines to the plot when values fall outside yMin..yMax', () => {
    const pts: Pt[] = [[t0, 5], [t0 + m, 30], [t0 + 2 * m, 50]];
    const { container } = render(<LineChart label="读数" series={[{ id: 'a', label: 'A', pts }]} yMin={20} yMax={40} w={400} />);
    const line = container.querySelector('path[data-series="a"]') as Element;
    const id = line.closest('[clip-path]')?.getAttribute('clip-path')?.match(/^url\(#(.+)\)$/)?.[1] ?? '';
    expect(id).not.toBe('');
    expect(container.querySelector(`clipPath[id="${id}"] rect`)).not.toBeNull();
  });

  it('reads a series without any value as — in the summary', () => {
    const series = [
      { id: 'a', label: 'A', pts: [[t0, 1], [t0 + m, 2]] as Pt[] },
      { id: 'b', label: 'B', pts: [[t0, null]] as Pt[] },
    ];
    const { container } = render(<LineChart label="读数" series={series} w={400} />);
    const aria = container.querySelector('svg[role="img"]')?.getAttribute('aria-label') ?? '';
    expect(aria).toContain('B 最新 —，最高 —，最低 —');
  });

  it('paints isolated samples as dots', () => {
    const pts: Pt[] = [[t0, 1], [t0 + m, null], [t0 + 2 * m, 5], [t0 + 3 * m, null], [t0 + 4 * m, 9]];
    const { container } = render(<LineChart label="读数" series={[{ id: 'a', label: 'A', pts }]} w={400} />);
    const subs = (container.querySelector('path[data-series="a"]')?.getAttribute('d') ?? '').split('M').filter(Boolean);
    expect(subs).toHaveLength(3);
    for (const s of subs) expect(s).toMatch(/[LHVh]/);
  });
});
