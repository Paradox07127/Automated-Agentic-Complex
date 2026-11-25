import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BracketMeter, HourArea, NodeChain, RunRing, SegMeter, Waterfall, WaterfallDemos } from '../../src/charts';
import { StateMark } from '../../src/charts/StateMark';
import { stageDuration } from '../../src/charts/Waterfall';
import { stateVisual, type VisualStateKey } from '../../src/domain';

afterEach(cleanup);

const demo = <T,>(list: Array<{ name: string; props: T }>, name: string): T => {
  const d = list.find((x) => x.name === name);
  if (!d) throw new Error(`no demo ${name}`);
  return d.props;
};

const toggleTable = (c: HTMLElement) => {
  const btn = c.querySelector('[data-table-toggle]');
  if (!btn) throw new Error('no table toggle');
  fireEvent.click(btn);
};

const tableRows = (c: HTMLElement) => [...c.querySelectorAll('[data-chart-table] tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent ?? ''));

describe('three state channels: colour + shape + text', () => {
  const states: VisualStateKey[] = ['running', 'waiting', 'warning', 'failed', 'succeeded', 'interrupted', 'cancelled', 'pending'];
  for (const s of states) {
    it(s, () => {
      const v = stateVisual(s);
      const { container } = render(<StateMark state={s} />);
      const mark = container.firstElementChild as HTMLElement;
      const svg = mark.querySelector('svg');
      expect(svg?.getAttribute('style')).toContain(`var(${v.token})`);
      expect(svg?.getAttribute('data-shape')).toBe(v.shape);
      expect(svg?.childElementCount).toBe(1);
      expect(mark.textContent).toBe(v.label);
    });
  }

  it('codes interrupt and cancel as the hollow square in the cancelled grey', () => {
    expect(stateVisual('interrupted').shape).toBe('hollow-square');
    const { container } = render(<RunRing state="interrupted" />);
    const ring = container.querySelector('[data-stub="RunRing"]');
    expect(ring?.getAttribute('data-shape')).toBe('hollow-square');
    expect(ring?.getAttribute('aria-label')).toBe('已中断');
    expect(ring?.querySelector('svg')?.getAttribute('style')).toContain('--ef-state-cancelled');
  });

  it('gives run rings shape, colour family and label', () => {
    const { container } = render(<RunRing state="awaiting_approval" phase="awaiting" />);
    const ring = container.querySelector('[data-stub="RunRing"]');
    expect(ring?.getAttribute('data-tone')).toBe('waiting');
    expect(ring?.getAttribute('data-shape')).toBe('diamond');
    expect(ring?.getAttribute('aria-label')).toBe('待批准');
    expect(ring?.textContent).toBe('待');
  });

  it('pairs meter thresholds with ▲ / ■ shapes', () => {
    const level = (value: number) => {
      const { container, unmount } = render(<BracketMeter value={value} max={100} label="额度" />);
      const el = container.querySelector('[data-stub="BracketMeter"]');
      const out = [el?.getAttribute('data-level'), el?.querySelector('[data-shape]')?.getAttribute('data-shape') ?? null, el?.getAttribute('aria-label')];
      unmount();
      return out;
    };
    expect(level(0)).toEqual(['ok', null, '额度 0/100，正常']);
    expect(level(70)).toEqual(['high', 'triangle', '额度 70/100，偏高']);
    expect(level(90)).toEqual(['over', 'square', '额度 90/100，接近上限']);
    expect(level(150)).toEqual(['over', 'square', '额度 150/100，超限']);
  });

  it('marks waiting and failed steps with shape and text', () => {
    const { container } = render(<SegMeter steps={[{ text: 'a', status: 'completed', since: null }, { text: 'b', status: 'waiting', since: null }, { text: 'c', status: 'pending', since: null }]} />);
    const el = container.querySelector('[data-stub="SegMeter"]');
    expect(el?.getAttribute('aria-label')).toBe('步骤 1/3，待处理：b');
    expect([...container.querySelectorAll('[data-kind]')].map((c) => c.getAttribute('data-kind'))).toEqual(['completed', 'waiting', 'pending']);
    expect(el?.textContent).toContain('◆ 待处理');
    expect(el?.textContent).toContain('1/3');
  });

  it('draws final success as a green ✓ and breaks as ✕ with unreachable downstream', () => {
    const { container } = render(<NodeChain label="交付" nodes={[{ label: '产出', state: 'done' }, { label: '断', state: 'broken' }, { label: '决定', state: 'ok' }]} recovery="重新连接" />);
    const items = [...container.querySelectorAll('li')];
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(['done', 'broken', 'unreachable']);
    expect(items[1]?.textContent).toContain('✕');
    expect(items[2]?.textContent).toContain('不可达');
    cleanup();
    const ok = render(<NodeChain label="交付" nodes={[{ label: '产出', state: 'done' }, { label: '已接受', state: 'ok' }]} />);
    expect(ok.container.querySelector('li[data-state="ok"]')?.textContent).toContain('✓');
  });

  it('ends a waterfall with a green ✓ terminal and writes 「□ 打断 · ptt」', () => {
    const ok = render(<Waterfall {...demo(WaterfallDemos, 'run-ok')} />);
    const term = ok.container.querySelector('[data-terminal="ok"][role="img"]');
    expect(term?.textContent).toBe('✓');
    expect(term?.getAttribute('aria-label')).toBe('最终成功');
    cleanup();
    const turn = render(<Waterfall {...demo(WaterfallDemos, 'turn')} />);
    toggleTable(turn.container);
    const rows = tableRows(turn.container);
    expect(rows.at(-1)?.at(-1)).toBe('打断 │ ptt');
    expect(turn.container.querySelector('[data-shape="hollow-square"]')).not.toBeNull();
  });
});

describe('chart readouts', () => {
  it('HourArea writes the now plate at the exact minute', () => {
    const { container } = render(<HourArea label="每小时" name="在电脑前" unit="分钟 / 小时" hours={Array.from({ length: 24 }, () => 10)} max={60} now={14 + 36 / 60} tip={(v) => String(v)} w={480} />);
    // (14 + 36/60) % 1 * 60 is 35.99…, which floored to 14:35.
    expect(container.querySelector('[data-now] text')?.textContent).toBe('14:36');
  });
});

describe('table view shows the same data as the drawing', () => {
  it('Waterfall', () => {
    const { container } = render(<Waterfall {...demo(WaterfallDemos, 'run-ok')} />);
    const segs = [...container.querySelectorAll('button[data-status]')].map((b) => [b.getAttribute('data-status'), Number(b.getAttribute('data-duration'))]);
    toggleTable(container);
    const rows = tableRows(container);
    expect(rows).toHaveLength(segs.length);
    expect(rows.map((r) => r[3])).toEqual(segs.map(([, d]) => stageDuration(d as number)));
    expect(rows.map((r) => r[3])).toEqual(['20 s', '1 分', '15 s', '5 分', '1 分']);
    expect(rows.map((r) => r[4])).toEqual(segs.map(([s]) => (s === 'failed' ? '失败' : '已完成')));
  });
});
