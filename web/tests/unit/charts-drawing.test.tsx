import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Gantt,
  GanttDemos,
  LineChart,
  LineChartDemos,
  StackedBars,
  StackedBarsDemos,
} from '../../src/charts';
import { GANTT_ROWS, GANTT_STATES } from '../../src/charts/Gantt';
import { rulerLabels } from '../../src/charts/Track';

afterEach(cleanup);

const at = (h: number, m: number) => new Date(2026, 9, 29, h, m).getTime();
const clock = (t: number) => new Date(t).toTimeString().slice(0, 5);

type Entry = [string, ComponentType<Record<string, unknown>>, Array<{ name: string; props: object }>];
const NEW: Entry[] = [
  ['LineChart', LineChart as never, LineChartDemos],
  ['StackedBars', StackedBars as never, StackedBarsDemos],
  ['Gantt', Gantt as never, GanttDemos],
];

describe('charts: drawing, empty state, table view', () => {
  for (const [name, C, demos] of NEW) {
    const full = demos.find((d) => d.name !== 'empty' && !('st' in d.props))!;
    const empty = demos.find((d) => d.name === 'empty')!;

    it(`${name} draws a labelled chart in a frame`, () => {
      const { container } = render(<C {...(full.props as Record<string, unknown>)} />);
      const root = container.querySelector(`[data-stub="${name}"]`) as HTMLElement;
      expect(root).not.toBeNull();
      expect(root.hasAttribute('data-empty')).toBe(false);
      const drawing = root.querySelector('[role="img"][aria-label], [role="group"][aria-label]');
      expect(drawing?.getAttribute('aria-label')).toMatch(/^.+：.+/);
      expect(root.querySelector('[data-table-toggle]')?.getAttribute('aria-label')).toBe('以表格查看');
    });

    it(`${name} shows one line of reason when empty, without axes or table switch`, () => {
      const { container } = render(<C {...(empty.props as Record<string, unknown>)} />);
      const root = container.querySelector(`[data-stub="${name}"]`) as HTMLElement;
      expect(root.hasAttribute('data-empty')).toBe(true);
      expect(root.querySelector('svg:not([aria-hidden]), [data-table-toggle], [role="img"]')).toBeNull();
      expect(root.textContent).toBe((empty.props as { empty: string }).empty);
    });

    it(`${name} switches to the table and back`, () => {
      const { container } = render(<C {...(full.props as Record<string, unknown>)} />);
      const root = container.querySelector(`[data-stub="${name}"]`) as HTMLElement;
      fireEvent.click(root.querySelector('[data-table-toggle]') as Element);
      expect(root.getAttribute('data-table')).toBe('true');
      expect(root.querySelectorAll('[data-chart-table] tbody tr').length).toBeGreaterThan(0);
      expect(root.querySelector('[data-table-toggle]')?.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(root.querySelector('[data-table-toggle]') as Element);
      expect(root.querySelector('[data-chart-table]')).toBeNull();
    });
  }

  it('keeps the loading skeleton and the stale data of an error', () => {
    const loading = render(<LineChart label="加载态" st="loading" series={[]} h={40} />);
    expect(loading.container.querySelector('[data-state="loading"]')).not.toBeNull();
    expect(loading.container.querySelector('[data-table-toggle]')).toBeNull();
    cleanup();
    const err = render(<LineChart {...LineChartDemos[0]!.props} st="error" />);
    expect(err.container.querySelector('[data-state="error"] [data-stale] svg[role="img"]')).not.toBeNull();
  });
});

describe('monochrome plus one emphasis', () => {
  it('draws series in ink greys and the emph one in the emphasis colour', () => {
    const { container } = render(<LineChart {...LineChartDemos.find((d) => d.name === 'emph')!.props} />);
    expect(container.querySelector('path[data-series="e"]')?.getAttribute('stroke')).toBe('var(--v3-emph)');
    // The emphasis is ink on paper, so the other series start one step lighter.
    expect(container.querySelector('path[data-series="m"]')?.getAttribute('stroke')).toBe('var(--v3-ink-2)');
  });

  it('fills the series without colours with ink, secondary ink, chip and the hatch pattern', () => {
    const cats = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id }));
    const { container } = render(<StackedBars label="四档" w={300} buckets={[{ key: 'x', label: 'x', parts: { a: 4, b: 3, c: 2, d: 1 } }]} cats={cats} />);
    const rects = [...container.querySelectorAll('[data-bucket="x"] rect:not([fill="transparent"])')];
    expect(rects.map((r) => r.getAttribute('fill'))).toEqual(['var(--v3-ink-1)', 'var(--v3-ink-2)', 'var(--v3-chip)', expect.stringMatching(/^url\(#.+\)$/)]);
    expect(rects.map((r) => r.getAttribute('stroke'))).toEqual([null, null, 'var(--ef-line-strong)', 'var(--ef-line-strong)']);
  });

  it('bare writes no y ticks, end values or peak in the plot; the legend keeps the latest values', () => {
    const props = LineChartDemos.find((d) => d.name === 'emph')!.props;
    const { container } = render(<LineChart {...props} w={400} bare />);
    const texts = [...container.querySelectorAll('svg[role="img"] text')].map((t) => t.textContent ?? '');
    expect(texts.some((t) => /^-?\d+(\.\d+)?$/.test(t))).toBe(false);
    expect(container.textContent).toMatch(/精神 [-\d.]+/);
  });

  it('dashes only the limit line and labels it directly', () => {
    const { container } = render(<LineChart {...LineChartDemos.find((d) => d.name === 'limit')!.props} />);
    expect(container.querySelector('[data-limit] text')?.textContent).toBe('预算 16.7 ms');
  });

  it('maps the documented colour tokens onto the palette', () => {
    const { container } = render(<StackedBars {...StackedBarsDemos.find((d) => d.name === 'categories')!.props} />);
    const fills = [...container.querySelectorAll('[data-bucket="h9"] rect:not([fill="transparent"])')].map((r) => r.getAttribute('fill'));
    // 「其他」 is the hatch level: an SVG pattern.
    expect(fills).toEqual(['var(--v3-cat-1)', 'var(--v3-cat-2)', expect.stringMatching(/^url\(#.+\)$/)]);
  });
});

describe('now flag keeps clear of tick labels', () => {
  it('drops the label the flag would cover and keeps the others', () => {
    const t0 = at(8, 0);
    const t1 = at(14, 0);
    const all = rulerLabels(t0, t1, 416).map(clock);
    expect(all).toEqual(['08:00', '09:00', '10:00', '11:00', '12:00', '13:00']);
    expect(rulerLabels(t0, t1, 416, at(12, 1)).map(clock)).toEqual(['08:00', '09:00', '10:00', '11:00', '13:00']);
    expect(rulerLabels(t0, t1, 416, at(11, 50)).map(clock)).toEqual(['08:00', '09:00', '10:00', '11:00', '13:00']);
  });

  it('applies to the Gantt ruler', () => {
    const { container } = render(<Gantt label="甘特" rows={GANTT_ROWS} t0={at(9, 0)} t1={at(15, 0)} now={at(13, 1)} states={GANTT_STATES} />);
    const labels = [...container.querySelectorAll('[data-ruler] b')].map((b) => b.textContent);
    expect(container.querySelector('[data-now-flag]')?.textContent).toBe('13:01');
    expect(labels).not.toContain('13:00');
    expect(labels).toContain('12:00');
  });
});

describe('Gantt maxRows', () => {
  const rows = [...GANTT_ROWS, ...GANTT_ROWS.map((r) => ({ ...r, id: `${r.id}b` }))];

  it('folds rows past maxRows into 「另有 N 个」 and unfolds them', () => {
    const { container, getByText } = render(<Gantt label="甘特" rows={rows} t0={at(9, 0)} t1={at(15, 0)} now={at(14, 32)} states={GANTT_STATES} maxRows={6} />);
    expect(container.querySelectorAll('[data-row]')).toHaveLength(6);
    const more = container.querySelector('[data-more]') as HTMLElement;
    expect(more.textContent).toBe('另有 2 个');
    fireEvent.click(more);
    expect(container.querySelectorAll('[data-row]')).toHaveLength(8);
    fireEvent.click(getByText('收起'));
    expect(container.querySelectorAll('[data-row]')).toHaveLength(6);
  });

  it('shows every row when within maxRows', () => {
    const { container } = render(<Gantt label="甘特" rows={GANTT_ROWS} t0={at(9, 0)} t1={at(15, 0)} states={GANTT_STATES} maxRows={6} />);
    expect(container.querySelectorAll('[data-row]')).toHaveLength(4);
    expect(container.querySelector('[data-more]')).toBeNull();
  });
});
