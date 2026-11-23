import type { ComponentType } from 'react';
import * as charts from '../../../src/charts';
import * as ui from '../../../src/ui';
import * as game from '../../../src/ui/game';

// Every component file exports `<Name>` and `<Name>Demos`; the catalog pairs them by name, so new components need no registration.

export interface CatalogDemo {
  name: string;
  props: Record<string, unknown>;
}

export interface CatalogEntry {
  name: string;
  /** `ui`, `ui/game`, `charts` or `features/<dir>`. */
  group: string;
  component: ComponentType<Record<string, unknown>>;
  demos: CatalogDemo[];
}

function collect(group: string, mod: Record<string, unknown>): CatalogEntry[] {
  return Object.keys(mod)
    .filter((k) => k.endsWith('Demos'))
    .sort()
    .flatMap((k) => {
      const name = k.slice(0, -'Demos'.length);
      const component = mod[name];
      const demos = mod[k];
      if (typeof component !== 'function' || !Array.isArray(demos)) return [];
      return [{ name, group, component: component as CatalogEntry['component'], demos: demos as CatalogDemo[] }];
    });
}

const featureModules = import.meta.glob<Record<string, unknown>>('../../../src/features/*/index.ts', { eager: true });
// Feature demos that need mock data sit in `X.demos.tsx`, outside the barrels; they pair with the barrel's components.
const featureDemoModules = import.meta.glob<Record<string, unknown>>('../../../src/features/*/*.demos.tsx', { eager: true });

const dirOf = (path: string) => path.split('/').at(-2) ?? '';

function featureModule(path: string): Record<string, unknown> {
  const demos = Object.keys(featureDemoModules).filter((p) => dirOf(p) === dirOf(path));
  return Object.assign({}, featureModules[path], ...demos.map((p) => featureDemoModules[p]));
}

// The character area's game pieces list with the base components, under their own group.
export const uiCatalog: CatalogEntry[] = [...collect('ui', ui), ...collect('ui/game', game)];

export const featureCatalog: CatalogEntry[] = Object.keys(featureModules)
  .sort()
  .flatMap((path) => collect(`features/${dirOf(path)}`, featureModule(path)));

export const chartCatalog: CatalogEntry[] = collect('charts', charts);
