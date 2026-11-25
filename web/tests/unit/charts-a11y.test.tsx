import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BarList, CountdownRing, StackedBars, StackedBarsDemos, Waterfall, WaterfallDemos } from '../../src/charts';
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
const DESCRIBED = new Set(['BarList', 'NodeChain', 'Waterfall']);
/** Charts whose marks can be picked: role=group with the summary as its label instead of role=img. */
const PICKING = new Set(['Gantt', 'StackedBars']);

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

  it('keeps the countdown a named timer', () => {
    const { container } = render(<CountdownRing secondsLeft={23} windowS={55} />);
    const el = container.querySelector('[role="timer"]') as Element;
    expect(titleOf(el)).toContain('窗口 55 秒');
    expect(titleOf(el)).toMatch(/^剩余 23 秒/);
  });
});

describe('pick targets are keyboard buttons', () => {
  const press = (el: Element, key: string) => fireEvent.keyDown(el, { key });

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

describe('empty data draws no axes, one line of text instead', () => {
  const cases: Array<[string, () => ReturnType<typeof render>, string]> = [
    ['Waterfall', () => render(<Waterfall label="运行瀑布" totalMs={0} rows={[]} />), '运行瀑布：还没有阶段'],
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
});

describe('legend sits under the chart with a count per item', () => {
  const legendOf = (c: HTMLElement) => [...c.querySelectorAll('[data-chart-legend] li')].map((li) => li.textContent?.replace(/\s+/g, ' ').trim());
  const after = (a: Element | null, b: Element | null) => !!a && !!b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;

  it('Waterfall: one item per stage status present', () => {
    const { container } = render(<Waterfall {...demo(WaterfallDemos, 'run-ok')} />);
    expect(after(container.querySelector('[data-chart-legend]'), container.querySelector('button[data-status]'))).toBe(true);
    expect(legendOf(container)).toEqual(['已完成 4', '失败 1']);
  });
});

describe('colour carries state only; categories are text', () => {
  it('no chart style keys a colour on a lane kind or category', () => {
    for (const f of ['SegMeter.module.css', 'RunRing.module.css', 'NodeChain.module.css']) {
      const css = readFileSync(resolve(chartsDir, f), 'utf8');
      expect(css, f).not.toMatch(/data-category/);
      expect(css, f).not.toMatch(/--ef-mission/);
    }
  });
});

describe('chart type uses the new scale', () => {
  const sheets = readdirSync(chartsDir).filter((f) => f.endsWith('.css'));

  it('uses no retired aliases and no literal font sizes', () => {
    for (const f of sheets) {
      const css = readFileSync(resolve(chartsDir, f), 'utf8');
      expect(css, f).not.toMatch(/--ef-(fs-(keycap|code|meta|mono|small|h[123]|num|table|body-lg|row|big|num-[a-z]+)|bg-base|bg-canvas|row\)|slab|plate|band|fold)\b/);
      expect(css, f).not.toMatch(/font(-size)?:[^;]*\b\d+px/);
    }
  });

  it('sets tick numbers in the number role with tabular figures', () => {
    for (const [f, sel] of [['Waterfall.module.css', '.tick {']] as const) {
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
