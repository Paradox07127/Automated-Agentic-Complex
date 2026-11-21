import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { chartCatalog, featureCatalog, uiCatalog, type CatalogEntry } from '../../src/dev/catalog';
import { route as dsRoute } from '../../src/dev/ds/route';
import { route as dvRoute } from '../../src/dev/dv/route';

afterEach(cleanup);

const groups: Array<[string, CatalogEntry[]]> = [
  ['ui', uiCatalog],
  ['charts', chartCatalog],
  ['features', featureCatalog],
];

describe('component catalog', () => {
  it('finds the agreed component sets', () => {
    expect(uiCatalog.length).toBeGreaterThanOrEqual(25);
    expect(chartCatalog.map((e) => e.name)).toEqual(
      expect.arrayContaining([
        'BracketMeter', 'SegMeter', 'CountdownRing', 'CountdownLine', 'NodeChain', 'Swimlane', 'Waterfall',
        'CompositionBar', 'BarList', 'Sparkline', 'DotStrip', 'SmallMultiples', 'ChartState',
      ]),
    );
    expect(featureCatalog.map((e) => e.group)).toEqual(
      expect.arrayContaining(['features/approval', 'features/kernel', 'features/health', 'features/delivery', 'features/task', 'features/plan']),
    );
  });

  for (const [group, entries] of groups) {
    it(`renders every ${group} demo with its stub marker`, () => {
      for (const e of entries) {
        expect(e.demos.length, e.name).toBeGreaterThan(0);
        for (const d of e.demos) {
          const { container, unmount } = render(<e.component {...d.props} />);
          const marked = container.querySelector(`[data-stub="${e.name}"]`);
          // CountdownLine and CountBadge render nothing for some inputs; every listed demo must show something.
          expect(marked, `${e.name}/${d.name}`).not.toBeNull();
          unmount();
        }
      }
    });
  }

  it('lists one URL per demo on #/ds and #/dv', () => {
    const ds = new Set(dsRoute.demos.map((d) => `${d.params.c}/${d.params.d}`));
    for (const e of [...uiCatalog, ...featureCatalog]) for (const d of e.demos) expect(ds.has(`${e.name}/${d.name}`)).toBe(true);
    const dv = new Set(dvRoute.demos.map((d) => `${d.params.c}/${d.params.d}`));
    for (const e of chartCatalog) for (const d of e.demos) expect(dv.has(`${e.name}/${d.name}`)).toBe(true);
    const names = [...dsRoute.demos, ...dvRoute.demos].map((d) => d.name);
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9-]+$/);
  });
});
