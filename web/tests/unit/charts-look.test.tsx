import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Gantt, GanttDemos, LineChart, LineChartDemos, StackedBars, StackedBarsDemos } from '../../src/charts';
import { ShapeGlyph } from '../../src/charts/StateMark';

afterEach(cleanup);

const chartsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/charts');
const sheets = readdirSync(chartsDir).filter((f) => f.endsWith('.css'));
const sources = readdirSync(chartsDir).filter((f) => f.endsWith('.tsx'));

describe(' failures are yellow blocks with ink, never red', () => {
  it('draws a failure glyph as ✕ in ink on a yellow block', () => {
    const { container } = render(<ShapeGlyph shape="square" token="--ef-state-failed" />);
    const svg = container.querySelector('svg')!;
    expect(svg.style.color).toBe('var(--ef-state-failed)');
    expect(svg.querySelector('rect')?.getAttribute('fill')).toBe('currentColor');
    expect(svg.querySelector('path')?.getAttribute('d')).toBe('M1.5 1.5l7 7M8.5 1.5l-7 7');
    expect(svg.querySelector('path')?.getAttribute('stroke')).toBe('var(--ef-on-accent)');
  });

  it('keeps plain states as one shape in their own colour', () => {
    const { container } = render(<ShapeGlyph shape="square" token="--ef-state-ok" />);
    expect(container.querySelectorAll('svg rect')).toHaveLength(1);
    expect(container.querySelector('svg rect')?.getAttribute('fill')).toBe('currentColor');
  });

  it('uses no danger colour in any chart', () => {
    for (const f of [...sheets, ...sources]) expect(readFileSync(resolve(chartsDir, f), 'utf8'), f).not.toMatch(/--ef-danger\b|--ef-success\)/);
  });
});

describe(' the emphasis stays apart from the ink series', () => {
  it('steps the other bars down to secondary ink while one bar is emphasised', () => {
    const { container } = render(<StackedBars {...StackedBarsDemos.find((d) => d.name === 'emph-bucket')!.props} />);
    const fill = (key: string) => container.querySelector(`[data-bucket="${key}"] rect:not([fill="transparent"])`)?.getAttribute('fill');
    expect(fill('h14')).toBe('var(--v3-emph)');
    expect(fill('h9')).toBe('var(--v3-ink-2)');
  });

  it('steps the other Gantt states down while a row is emphasised', () => {
    const props = GanttDemos.find((d) => d.name === 'emph')!.props;
    const { container } = render(<Gantt {...props} />);
    const seg = (row: string) => (container.querySelector(`[data-row="${row}"] i`) as HTMLElement).style.background;
    expect(seg('g2')).toBe('var(--v3-emph)');
    expect(seg('g1')).toBe('var(--v3-ink-2)');
  });
});

describe(' chart frames and strokes', () => {
  it('draws no corner marks around a chart box', () => {
    const { container } = render(<LineChart {...LineChartDemos[0]!.props} />);
    const root = container.querySelector('[data-stub="LineChart"]')!;
    expect([...root.children].some((el) => el.tagName === 'SPAN' && el.getAttribute('aria-hidden') === 'true' && !el.textContent)).toBe(false);
  });

  it('ends lines square and rounds no corner', () => {
    for (const f of sheets) {
      const css = readFileSync(resolve(chartsDir, f), 'utf8');
      expect(css, f).not.toMatch(/border-radius/);
      expect(css, f).not.toMatch(/stroke-line(cap|join):\s*round/);
      expect(css, f).not.toMatch(/box-shadow:\s*var\(--ef-shadow|filter:|text-shadow/);
    }
    for (const f of sources) {
      const src = readFileSync(resolve(chartsDir, f), 'utf8');
      expect(src, f).not.toMatch(/strokeLine(cap|join)="round"|\brx=/);
    }
  });

  it('sets chart figures in the UI face with tabular figures', () => {
    for (const f of sheets) expect(readFileSync(resolve(chartsDir, f), 'utf8'), f).not.toMatch(/--ef-font-(num|din)\b/);
  });
});
