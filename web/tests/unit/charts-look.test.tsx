import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FlowGraph, FlowGraphDemos, Gantt, GanttDemos, LineChart, LineChartDemos, StackedBars, StackedBarsDemos } from '../../src/charts';
import { ShapeGlyph } from '../../src/charts/StateMark';

afterEach(cleanup);

const chartsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/charts');
const sheets = readdirSync(chartsDir).filter((f) => f.endsWith('.css'));
const sources = readdirSync(chartsDir).filter((f) => f.endsWith('.tsx'));
const demo = FlowGraphDemos.find((d) => d.name === 'live')!.props;

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

  it('flags a flow node failure count as ✕n on a yellow block, not in the stat line', () => {
    const { container } = render(<FlowGraph {...demo} />);
    const tts = container.querySelector('[data-node="tts"]')!;
    expect(tts.querySelector('[data-flag] text')?.textContent).toBe('✕2');
    expect(tts.querySelector('[data-flag] rect')).not.toBeNull();
    expect(container.querySelector('[data-node="interp"] [data-flag] text')?.textContent).toBe('✕1');
    expect(container.querySelector('[data-node="obs"] [data-flag]')).toBeNull();
    expect(tts.textContent).not.toMatch(/· ✕/);
  });

  it('uses no danger colour in any chart', () => {
    for (const f of [...sheets, ...sources]) expect(readFileSync(resolve(chartsDir, f), 'utf8'), f).not.toMatch(/--ef-danger\b|--ef-success\)/);
  });
});

describe(' FlowGraph nodes', () => {
  it('cuts the bottom-right corner of pressable nodes and gives them the trace tab', () => {
    const { container } = render(<FlowGraph {...demo} />);
    const node = container.querySelector('[data-node="judge"]')!;
    expect(node.hasAttribute('data-press')).toBe(true);
    const w = demo.nodeW!;
    const h = demo.nodeH!;
    expect(node.querySelector('path')?.getAttribute('d')).toBe(`M0 0H${w}V${h - 8}L${w - 8} ${h}H0Z`);
    expect(node.querySelectorAll('rect').length).toBeGreaterThan(1);
  });

  it('keeps nodes that cannot be pressed square, without a tab', () => {
    const { container } = render(<FlowGraph {...demo} onPick={undefined} />);
    const node = container.querySelector('[data-node="judge"]')!;
    expect(node.hasAttribute('data-press')).toBe(false);
    expect(node.querySelector('path')?.getAttribute('d')).toBe(`M0 0H${demo.nodeW}V${demo.nodeH}H0Z`);
  });

  it('draws the current turn as one trace dot, without a halo', () => {
    const replay = FlowGraphDemos.find((d) => d.name === 'replay')!.props;
    const { container } = render(<FlowGraph {...replay} />);
    const dots = [...container.querySelectorAll('svg > circle')];
    expect(dots).toHaveLength(1);
    expect(dots[0]?.getAttribute('r')).toBe('4');
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
