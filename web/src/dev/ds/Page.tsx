import { useRouterState } from '@tanstack/react-router';
import { chartCatalog, featureCatalog, uiCatalog } from '../catalog';
import { CatalogToc } from '../CatalogToc';
import { CatalogView } from '../CatalogView';
import { Material } from './Material';
import styles from './Page.module.css';

/** `#/ds`: the material section, then every base component and shared composite; `?c=<Name>&d=<demo>` shows one demo, `?sec=material` only the material section. */
export function DesignSystemPage() {
  const q = useRouterState({ select: (s) => s.location.searchStr });
  const params = new URLSearchParams(q);
  const view = <CatalogView entries={[...uiCatalog, ...featureCatalog]} />;
  if (params.has('c')) return view;
  if (params.get('sec') === 'material') return <Material />;
  return (
    <div className={styles.page}>
      <CatalogToc ui={uiCatalog} charts={chartCatalog} features={featureCatalog} />
      <div className={styles.main}>
        <Material />
        {view}
      </div>
    </div>
  );
}
