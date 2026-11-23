import { StrictMode, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/design/tokens.css';
import '../../../src/design/base.css';
import { getBridge, loadFakeBridge } from '../../../src/bridge';
import { ChartState } from '../../../src/charts';
import { parseDemo } from '../../../src/shell/demo';
import { loadPlugins } from '../../../src/shell/plugins';
import { applyInitialTheme, useSystemTheme } from '../../../src/shell/useSystemTheme';
import { MODAL_ROOT_ID } from '../../../src/ui';
import { chartCatalog, featureCatalog, uiCatalog, type CatalogEntry } from './catalog';
import styles from './Catalog.module.css';

// Mounts component demos for the e2e specs: `index.html#?c=<Name>&d=<demo>`, with the shell's `still`, `theme`,
// `plugins` (read by the fake bridge) and, for charts, `state=loading|empty|error`; without `d`, every demo of `c`.

declare global {
  interface Window {
    /** Every component and its demo names, for specs that loop over them. */
    __EF_CATALOG__?: ReadonlyArray<{ name: string; group: string; demos: readonly string[] }>;
  }
}

const ENTRIES: CatalogEntry[] = [...uiCatalog, ...featureCatalog, ...chartCatalog];

/** Stop time shown by a chart's error state (fixture day, 14:31). */
const STOPPED_AT = new Date(2026, 9, 29, 14, 31).getTime();

window.__EF_CATALOG__ = Object.freeze(ENTRIES.map((e) => ({ name: e.name, group: e.group, demos: e.demos.map((d) => d.name) })));

const hashQuery = () => {
  const i = location.hash.indexOf('?');
  return i < 0 ? '' : location.hash.slice(i + 1);
};

const onHash = (fn: () => void) => {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
};

function Catalog() {
  // A spec may change only the hash; the page then stays loaded and re-renders.
  const search = useSyncExternalStore(onHash, hashQuery);
  const q = new URLSearchParams(search);
  const c = q.get('c');
  const d = q.get('d');
  const { state, still, theme } = parseDemo(search);
  const shown = ENTRIES.filter((e) => e.name === c);

  useSystemTheme(theme);
  useEffect(() => {
    document.documentElement.classList.toggle('still', still);
  }, [still]);
  useEffect(() => void loadPlugins(getBridge()), []);

  const wrap = (e: CatalogEntry, node: ReactNode) =>
    state && e.group === 'charts' ? (
      <ChartState state={state} emptyText="演示空态：写原因和下一步" stoppedAt={STOPPED_AT}>
        {node}
      </ChartState>
    ) : (
      node
    );

  return (
    <>
      <main className={styles.root}>
        {c && shown.length === 0 && <p className={styles.missing}>没有组件 {c}</p>}
        {shown.map((e) => (
          <section key={`${e.group}/${e.name}`} className={styles.entry} data-component={e.name}>
            <h2 className={styles.name}>
              {e.name}
              <span className={styles.group}>{e.group}</span>
            </h2>
            {e.demos
              .filter((demo) => !d || demo.name === d)
              .map((demo) => (
                <figure key={demo.name} className={styles.demo} data-demo={`${e.name}-${demo.name}`} data-modal-inline="">
                  <figcaption className={styles.caption}>{demo.name}</figcaption>
                  <div className={styles.stage}>{wrap(e, <e.component {...demo.props} />)}</div>
                </figure>
              ))}
          </section>
        ))}
      </main>
      <div id={MODAL_ROOT_ID} className={styles.modalRoot} />
    </>
  );
}

await loadFakeBridge();
applyInitialTheme();
const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <Catalog />
  </StrictMode>,
);
