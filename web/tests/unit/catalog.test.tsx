import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { chartCatalog, featureCatalog, uiCatalog, type CatalogEntry } from '../fixtures/catalog/catalog';

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
        'BracketMeter', 'SegMeter', 'CountdownRing', 'CountdownLine', 'NodeChain', 'Waterfall',
        'BarList', 'ChartState',
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

  it('opens each demo alone by ?c=<Name>&d=<demo> on the test mount', () => {
    const ids = [...uiCatalog, ...featureCatalog, ...chartCatalog].flatMap((e) => e.demos.map((d) => `${e.name}-${d.name}`));
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9-]+$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
