import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BarList, CompositionBar, CompositionBarDemos, CountdownRing, DotStrip, DotStripDemos, FlowGraph, FlowGraphDemos, SmallMultiples, SmallMultiplesDemos, StackedBars, StackedBarsDemos, Swimlane, SwimlaneDemos, Timeline, TimelineDemos, Treemap, TreemapDemos, Waterfall, WaterfallDemos } from '../../src/charts';
import { DataTable } from '../../src/charts/ChartTable';
import { Gantt, GANTT_ROWS, GANTT_STATES } from '../../src/charts/Gantt';
import { NodeChain, NodeChainDemos } from '../../src/charts/NodeChain';
import { chartCatalog } from '../fixtures/catalog/catalog';

afterEach(cleanup);

const chartsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/charts');

const demo = <T,>(list: Array<{ name: string; props: T }>, name: string): T => {
  const d = list.find((x) => x.name === name);
  if (!d) throw new Error(`no demo ${name}`);
  return d.props;
};

const ref = (el: Element, attr: string) => {
  const ids = el.getAttribute(attr);
  return ids ? ids.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim() : '';
};

/** Accessible title of a drawing: the element its aria-labelledby names, else its aria-label. */
const titleOf = (el: Element) => ref(el, 'aria-labelledby') || (el.getAttribute('aria-label') ?? '');

// ChartState wraps a chart; CountdownRing is a role=timer readout and CountdownLine its aria-hidden decoration (checked below).
const NOT_DRAWINGS = new Set(['ChartState', 'CountdownRing', 'CountdownLine']);
/** Charts that carry a separate description besides the title. */
const DESCRIBED = new Set(['BarList', 'CompositionBar', 'DotStrip', 'NodeChain', 'SmallMultiples', 'Swimlane', 'Waterfall']);
/** Charts whose marks can be picked: role=group with the summary as its label instead of role=img. */
const PICKING = new Set(['FlowGraph', 'Gantt', 'StackedBars', 'Timeline', 'Treemap']);

describe('every chart is a role=img with a title', () => {
  for (const e of chartCatalog.filter((c) => !NOT_DRAWINGS.has(c.name))) {
    for (const d of e.demos) {
      it(`${e.name}/${d.name}`, () => {
        const { container } = render(<e.component {...d.props} />);
        const root = container.querySelector(`[data-stub="${e.name}"]`);
        if (root?.hasAttribute('data-empty') || root?.hasAttribute('data-table')) return;
        if (e.name === 'BarList' && d.props.onPick) {
          // Picking rows are buttons, so the list keeps its role and takes the same title and desc.
          expect(root?.getAttribute('role')).toBeNull();
          expect(titleOf(root as Element)).toBe(d.props.label);
          expect(ref(root as Element, 'aria-describedby')).not.toBe('');
          return;
        }
        if (e.name === 'NodeChain' && (d.props.nodes as Array<{ tip?: string }>).some((n) => n.tip)) {
          // Nodes with a tip take focus, so the chain stays a labelled list.
          const ol = container.querySelector('ol') as Element;
          expect(ol.getAttribute('role')).toBeNull();
          expect(titleOf(ol)).toBe(d.props.label);
          expect(ref(ol, 'aria-describedby')).not.toBe('');
          return;
        }
        const group = root?.querySelector('[role="group"][aria-label]');
        if (PICKING.has(e.name) && group) {
          // Charts with picking marks stay a labelled group around them.
          expect(group.getAttribute('aria-label'), 'group label').toMatch(/^.+：/);
          expect(container.querySelector('[role="img"] button, [role="img"] [tabindex]'), 'focusable inside role=img').toBeNull();
          return;
        }
        const imgs = [...container.querySelectorAll('[role="img"]')];
        expect(imgs.length, 'role=img').toBeGreaterThan(0);
        for (const img of imgs) expect(titleOf(img), 'title').not.toBe('');
        // role=img children are presentational, so nothing focusable may sit inside one.
        expect(container.querySelector('[role="img"] button, [role="img"] [tabindex]'), 'focusable inside role=img').toBeNull();
        if (DESCRIBED.has(e.name)) {
          const main = imgs.find((i) => i.hasAttribute('aria-labelledby'));
          expect(main, 'title element').toBeTruthy();
          expect(document.getElementById(main?.getAttribute('aria-labelledby') ?? '')?.hasAttribute('data-chart-title')).toBe(true);
          expect(ref(main as Element, 'aria-describedby'), 'desc').not.toBe('');
        }
      });
    }
  }

  it('names the chart by its label and describes its counts', () => {
    const { container } = render(<DotStrip {...demo(DotStripDemos, 'day')} />);
    const svg = container.querySelector('svg[role="img"]') as Element;
    expect(titleOf(svg)).toBe('最近 24 h 轮次');
    expect(ref(svg, 'aria-describedby')).toBe('3 轮，失败 1，打断 1，进行中 0，成功 1，跳过 0');
  });

  it('keeps the countdown a named timer', () => {
    const { container } = render(<CountdownRing secondsLeft={23} windowS={55} />);
    const el = container.querySelector('[role="timer"]') as Element;
    expect(titleOf(el)).toContain('窗口 55 秒');
    expect(titleOf(el)).toMatch(/^剩余 23 秒/);
  });
});

describe('pick targets are keyboard buttons', () => {
  const press = (el: Element, key: string) => fireEvent.keyDown(el, { key });

  it('FlowGraph nodes', () => {
    const onPick = vi.fn();
    const { container } = render(<FlowGraph {...demo(FlowGraphDemos, 'live')} onPick={onPick} />);
    const nodes = [...container.querySelectorAll('[data-node]')];
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      expect(n.getAttribute('role')).toBe('button');
      expect(n.getAttribute('tabindex')).toBe('0');
      expect(n.getAttribute('aria-label')).toMatch(/^\d\d \S/);
    }
    press(nodes[1]!, 'Enter');
    expect(onPick).toHaveBeenLastCalledWith(nodes[1]!.getAttribute('data-node'));
    press(nodes[2]!, ' ');
    expect(onPick).toHaveBeenLastCalledWith(nodes[2]!.getAttribute('data-node'));
  });

  for (const horizontal of [false, true]) {
    it(`StackedBars ${horizontal ? 'horizontal' : 'vertical'} bars`, () => {
      const onPick = vi.fn();
      const { container } = render(<StackedBars {...demo(StackedBarsDemos, 'categories')} horizontal={horizontal} onPick={onPick} />);
      const bars = [...container.querySelectorAll('[data-bucket]')];
      expect(bars.length).toBeGreaterThan(0);
      for (const b of bars) {
        expect(b.getAttribute('role')).toBe('button');
        expect(b.getAttribute('tabindex')).toBe('0');
        expect(b.getAttribute('aria-label')).toMatch(/合计/);
      }
      press(bars[0]!, 'Enter');
      expect(onPick).toHaveBeenCalledWith(bars[0]!.getAttribute('data-bucket'));
    });
  }

  it('Treemap cells', () => {
    const onPick = vi.fn();
    const { container } = render(<Treemap {...demo(TreemapDemos, 'pick')} onPick={onPick} />);
    const cells = [...container.querySelectorAll('[data-cell]')];
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c.getAttribute('role')).toBe('button');
      expect(c.getAttribute('tabindex')).toBe('0');
      expect(c.getAttribute('aria-label')).toMatch(/%$/);
    }
    press(cells[0]!, 'Enter');
    expect(onPick).toHaveBeenCalledWith(cells[0]!.getAttribute('data-cell'));
  });

  it('marks stay out of the tab order without onPick', () => {
    const { container } = render(<Treemap {...demo(TreemapDemos, 'emph')} />);
    expect(container.querySelector('[data-cell][tabindex]')).toBeNull();
  });

  it('DataTable rows with onRow', () => {
    const onRow = vi.fn();
    const { container } = render(<DataTable caption="表" columns={[{ label: '名' }]} rows={[{ key: 'a', cells: ['A'] }, { key: 'b', cells: ['B'] }]} onRow={onRow} />);
    const rows = [...container.querySelectorAll('tbody tr')];
    for (const r of rows) expect(r.getAttribute('tabindex')).toBe('0');
    press(rows[1]!, 'Enter');
    expect(onRow).toHaveBeenCalledWith('b');
    cleanup();
    const still = render(<DataTable caption="表" columns={[{ label: '名' }]} rows={[{ key: 'a', cells: ['A'] }]} />);
    expect(still.container.querySelector('tbody tr[tabindex]')).toBeNull();
  });

  it('TimelineMinimap is a focusable slider that pans with the arrow keys', () => {
    const { container } = render(<Timeline {...demo(TimelineDemos, 'observe')} />);
    const body = container.querySelector('[data-v0]') as HTMLElement;
    fireEvent.wheel(body, { deltaY: -800, clientX: 300 });
    const v0 = Number(body.dataset.v0);
    const mm = container.querySelector('[data-minimap]') as HTMLElement;
    expect(mm.getAttribute('role')).toBe('slider');
    expect(mm.getAttribute('tabindex')).toBe('0');
    press(mm, 'ArrowRight');
    expect(Number(body.dataset.v0)).toBeGreaterThan(v0);
    press(mm, 'Home');
    expect(Number(body.dataset.v0)).toBe(demo(TimelineDemos, 'observe').t0);
  });
});

describe('chart text reaches assistive tech whole', () => {
  it('Gantt with fold buttons is a group, not a role=img around them', () => {
    const rows = [...GANTT_ROWS, ...GANTT_ROWS.map((r) => ({ ...r, id: `${r.id}b` }))];
    const { container } = render(<Gantt label="甘特" rows={rows} t0={GANTT_ROWS[0]!.segs[0]!.t0} t1={GANTT_ROWS[0]!.segs[0]!.t0 + 6 * 3_600_000} states={GANTT_STATES} maxRows={6} />);
    expect(container.querySelector('[data-more]')).not.toBeNull();
    expect(container.querySelector('[role="img"] button')).toBeNull();
    expect(container.querySelector('[data-more]')?.closest('[role="group"][aria-label]')).not.toBeNull();
  });

  it('BarList row buttons carry the full label and readout', () => {
    const label = 'api.example-service.internal';
    const { container } = render(<BarList label="今日调用" rows={[{ key: 'a', label, value: 12, readout: '12 次' }]} onPick={() => undefined} />);
    const btn = container.querySelector('li button') as Element;
    expect(btn.textContent).toContain('…');
    expect(btn.getAttribute('aria-label')).toBe(`${label} 12 次`);
  });

  it('NodeChain at main size names its segment durations in the description', () => {
    const { container } = render(<NodeChain {...demo(NodeChainDemos, 'delivery')} />);
    const ol = container.querySelector('ol') as Element;
    const desc = ref(ol, 'aria-describedby');
    for (const l of ['1 m', '3 m', '等待 2 m']) expect(desc).toContain(l);
  });
});

describe('CompositionBar radios keep focus and one tab stop', () => {
  const segments = [
    { key: 'w', label: '等你', count: 2, tone: 'waiting' as const },
    { key: 'r', label: '进行中', count: 3, tone: 'running' as const },
    { key: 'f', label: '失败', count: 1, tone: 'failed' as const },
  ];

  it('moves DOM focus with the arrow keys', () => {
    const { container } = render(<CompositionBar label="任务" segments={segments} value="w" />);
    const radios = () => [...container.querySelectorAll<HTMLElement>('[role="radio"]')];
    radios()[0]!.focus();
    fireEvent.keyDown(radios()[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(radios()[1]);
    expect(radios()[1]!.getAttribute('aria-checked')).toBe('true');
  });

  it('gives the tab stop to the first radio when the selected key has no count', () => {
    const { container } = render(<CompositionBar label="任务" segments={segments.map((s) => (s.key === 'f' ? { ...s, count: 0 } : s))} value="f" onPick={() => undefined} />);
    const stops = [...container.querySelectorAll('[role="radio"]')].filter((r) => r.getAttribute('tabindex') === '0');
    expect(stops.map((r) => r.textContent)).toEqual(['等你 2']);
  });
});

describe('empty data draws no axes, one line of text instead', () => {
  const cases: Array<[string, () => ReturnType<typeof render>, string]> = [
    ['DotStrip', () => render(<DotStrip {...demo(DotStripDemos, 'empty')} />), '今天的轮次：没有轮次'],
    ['SmallMultiples', () => render(<SmallMultiples {...demo(SmallMultiplesDemos, 'render')} series={[{ key: 'fps', label: '帧率', unit: 'fps', min: 0, max: 60, values: [null, null] }]} />), '渲染 60 s：没有数据'],
    ['Swimlane', () => render(<Swimlane {...demo(SwimlaneDemos, 'day')} lanes={[{ id: 'runs', label: '运行', kind: 'mission', bars: [] }]} />), '今日活动：这段时间没有记录'],
    ['Waterfall', () => render(<Waterfall label="运行瀑布" totalMs={0} rows={[]} />), '运行瀑布：还没有阶段'],
    ['CompositionBar', () => render(<CompositionBar {...demo(CompositionBarDemos, 'empty')} />), '还没有任务 │ 新建一个任务后这里按状态分段'],
    ['BarList', () => render(<BarList label="今日调用" rows={[]} />), '今日调用：没有可排行的数据'],
  ];
  for (const [name, draw, line] of cases) {
    it(name, () => {
      const { container } = draw();
      const root = container.querySelector(`[data-stub="${name}"]`);
      expect(root?.hasAttribute('data-empty')).toBe(true);
      expect(container.querySelector('svg')).toBeNull();
      expect(container.querySelector('[role="img"], [role="radiogroup"], [data-chart-legend], [data-table-toggle]')).toBeNull();
      expect(container.querySelectorAll('p')).toHaveLength(1);
      expect(container.textContent).toBe(line);
    });
  }

  it('keeps an empty lane next to a lane with data on the shared axis', () => {
    const { container } = render(<Swimlane {...demo(SwimlaneDemos, 'empty-lane')} />);
    expect(container.querySelector('[data-empty]')).toBeNull();
    expect(container.querySelector('[role="img"]')).not.toBeNull();
  });
});

describe('legend sits under the chart with a count per item', () => {
  const legendOf = (c: HTMLElement) => [...c.querySelectorAll('[data-chart-legend] li')].map((li) => li.textContent?.replace(/\s+/g, ' ').trim());
  const after = (a: Element | null, b: Element | null) => !!a && !!b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;

  it('DotStrip: moved out of the header line', () => {
    const { container } = render(<DotStrip {...demo(DotStripDemos, 'day')} />);
    const legend = container.querySelector('[data-chart-legend]');
    expect(after(legend, container.querySelector('svg[role="img"]'))).toBe(true);
    expect(legendOf(container)).toEqual(['失败 1', '打断 1', '进行中 0', '成功 1', '跳过 0']);
    expect(container.querySelector('[data-chart-legend] [data-zero]')?.textContent).toContain('0');
  });

  it('Swimlane: one item per lane and state present, plus gate failures', () => {
    const { container } = render(<Swimlane {...demo(SwimlaneDemos, 'day')} />);
    expect(after(container.querySelector('[data-chart-legend]'), container.querySelector('[data-bar]'))).toBe(true);
    expect(legendOf(container)).toEqual(['运行 │ 进行中 1', '运行 │ 失败 1', '运行 │ 已完成 1', '编码 │ 失败 1', '编码 │ 已完成 1', '审批 2', '▼门禁失败 1']);
    // 已完成 bars are drawn in chart-done grey, so the legend mark is too.
    expect(container.querySelector<SVGElement>('[data-chart-legend] [data-key="runs:ok"] svg')?.style.color).toBe('var(--ef-chart-done)');
    expect(container.querySelector('[data-chart-legend] [data-key="gate"] [aria-hidden="true"]')?.textContent).toBe('▼');
  });

  it('Waterfall: one item per stage status present', () => {
    const { container } = render(<Waterfall {...demo(WaterfallDemos, 'run-ok')} />);
    expect(after(container.querySelector('[data-chart-legend]'), container.querySelector('button[data-status]'))).toBe(true);
    expect(legendOf(container)).toEqual(['已完成 4', '失败 1']);
  });

  it('SmallMultiples: over-budget points and pauses, not in the header', () => {
    const { container } = render(<SmallMultiples {...demo(SmallMultiplesDemos, 'render')} />);
    expect(legendOf(container)).toEqual(['超预算 2', '暂停 1']);
    expect(container.querySelector('[data-table-toggle]')?.parentElement?.textContent).not.toContain('超预算');
  });

  it('CompositionBar: the legend is the filter, the bar is the picture', () => {
    const { container } = render(<CompositionBar {...demo(CompositionBarDemos, 'tasks')} />);
    const group = container.querySelector('[role="radiogroup"]');
    expect(after(group, container.querySelector('[role="img"]'))).toBe(true);
    expect([...(group?.querySelectorAll('[role="radio"]') ?? [])].map((r) => r.textContent)).toEqual(['待处理 3', '进行中 3', '已完成 1', '失败 1']);
    expect(container.querySelector('[role="img"] button, [role="img"] [tabindex]')).toBeNull();
  });
});

describe('colour carries state only; categories are text', () => {
  it('bars in lanes of different kinds take the colour of their state', () => {
    const { container } = render(<Swimlane {...demo(SwimlaneDemos, 'day')} />);
    const tone = (id: string) => container.querySelector(`[data-bar="${id}"]`)?.getAttribute('data-tone');
    expect([tone('run-0f11'), tone('s2')]).toEqual(['failed', 'failed']);
    expect([tone('run-77a2'), tone('s1')]).toEqual(['ok', 'ok']);
  });

  it('orange swimlane bars carry dark text on them', () => {
    const css = readFileSync(resolve(chartsDir, 'Swimlane.module.css'), 'utf8');
    for (const tone of ['waiting', 'warning']) {
      const sel = `.bar[data-tone='${tone}'] {`;
      const body = css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
      expect(body, tone).toContain('--on: var(--ef-on-attention)');
    }
  });

  it('no chart style keys a colour on a lane kind or category', () => {
    for (const f of ['Swimlane.module.css', 'SegMeter.module.css', 'RunRing.module.css', 'NodeChain.module.css']) {
      const css = readFileSync(resolve(chartsDir, f), 'utf8');
      expect(css, f).not.toMatch(f === 'Swimlane.module.css' ? /data-kind/ : /data-category/);
      expect(css, f).not.toMatch(/--ef-mission/);
    }
  });
});

describe('chart type uses the new scale', () => {
  const sheets = readdirSync(chartsDir).filter((f) => f.endsWith('.css'));

  it('uses no retired aliases and no literal font sizes', () => {
    for (const f of sheets) {
      const css = readFileSync(resolve(chartsDir, f), 'utf8');
      expect(css, f).not.toMatch(/--ef-(fs-(caption|small|body|micro|title-\d|eyebrow|num-[a-z]+)|bg-base|bg-canvas|row\)|slab|plate|band|fold)\b/);
      expect(css, f).not.toMatch(/font(-size)?:[^;]*\b\d+px/);
    }
  });

  it('sets tick numbers in the number role with tabular figures', () => {
    for (const [f, sel] of [['Swimlane.module.css', '.tick {'], ['Waterfall.module.css', '.tick {'], ['DotStrip.module.css', '.label {'], ['SmallMultiples.module.css', '.label {']] as const) {
      const css = readFileSync(resolve(chartsDir, f), 'utf8');
      const body = css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
      expect(body, f).toContain('font: var(--ef-t-num)');
      expect(body, f).toContain('tabular-nums');
    }
  });

  it('keeps hatch as the only texture', () => {
    for (const f of sheets) {
      const css = readFileSync(resolve(chartsDir, f), 'utf8');
      for (const m of css.matchAll(/repeating-linear-gradient\([^;]*/g)) expect(m[0], f).toMatch(/90deg/);
      expect(css, f).not.toMatch(/linear-gradient\(180deg/);
    }
  });
});
