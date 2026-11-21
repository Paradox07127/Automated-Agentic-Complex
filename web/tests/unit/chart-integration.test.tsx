import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CompositionBar, CompositionBarDemos, Swimlane, SwimlaneDemos, Waterfall, WaterfallDemos } from '../../src/charts';
import { navRoute } from '../../src/shell/nav';
import { T1 } from '../../src/mock/fixtures/ids';

afterEach(cleanup);

const demo = <T,>(list: Array<{ name: string; props: T }>, name: string): T => {
  const d = list.find((x) => x.name === name);
  if (!d) throw new Error(`no demo ${name}`);
  return d.props;
};

describe('chart props', () => {
  it('Swimlane: lane error replaces bars, gate failure ▼, hatched span, controlled selection', () => {
    const err = render(<Swimlane {...demo(SwimlaneDemos, 'lane-error')} />);
    const lane = err.container.querySelector('[data-error]');
    expect(lane?.textContent).toContain('/agent/sessions 返回 503');
    expect(lane?.querySelector('[data-bar]')).toBeNull();
    cleanup();
    const day = render(<Swimlane {...demo(SwimlaneDemos, 'day')} />);
    expect(day.container.querySelector('[data-gate="failed"]')?.textContent).toContain('▼');
    cleanup();
    const pres = render(<Swimlane {...demo(SwimlaneDemos, 'presence')} />);
    expect(pres.container.querySelector('[data-bar="x0"]')?.hasAttribute('data-hatched')).toBe(true);
    expect(pres.container.querySelector('[data-bar="a1"]')?.hasAttribute('data-selected')).toBe(true);
  });

  it('Waterfall: each run ends in its own terminal node; a picked tool highlights its ticks', () => {
    const { container } = render(<Waterfall {...demo(WaterfallDemos, 'run-ok')} />);
    const nodes = [...container.querySelectorAll('[role="img"][data-terminal]')].map((n) => n.getAttribute('data-terminal'));
    expect(nodes).toEqual(['failed', 'ok']);
    expect(container.querySelectorAll('[data-hl="on"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-hl="off"]')).toHaveLength(1);
  });

  it('CompositionBar: shade steps reach the segments', () => {
    const { container } = render(<CompositionBar {...demo(CompositionBarDemos, 'shades')} />);
    expect([...container.querySelectorAll('[role="radio"]')].map((b) => b.getAttribute('data-shade'))).toEqual(['1', '2', '3', null]);
  });
});

describe('navRoute', () => {
  it('derives the landing from the selection and keeps view flags', () => {
    window.location.hash = '#/overview?still=1&theme=light&tab=x';
    expect(navRoute({ page: 'overview', sel: T1 })).toBe(`/overview?sel=${encodeURIComponent(T1)}&focus=${encodeURIComponent(`task-${T1}`)}&theme=light&still=1`);
    expect(navRoute({ page: 'settings', group: 'perm', item: 'automation' })).toContain('focus=set-automation');
    expect(navRoute({ page: 'diag', item: 'usage' })).toContain('focus=diag-usage');
    expect(navRoute({ page: 'chat' })).toBe('/chat?focus=page&theme=light&still=1');
  });
});
