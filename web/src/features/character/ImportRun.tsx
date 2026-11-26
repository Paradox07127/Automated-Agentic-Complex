import type { ImportState } from '../../bridge';
import { importStageLabel } from './useImportState';
import styles from './ImportRun.module.css';

/** The package import running now: the folder's name, its stage, the percent and a bar; the bar's stripe moves while the stage runs. */
export function ImportRun({ state }: { state: ImportState }) {
  const pct = Math.round(Math.min(1, Math.max(0, state.fraction)) * 100);
  return (
    <div className={styles.run} role="status" aria-label="导入进度">
      <div className={styles.top}>
        <b>{state.title}</b>
        <span className={styles.k}>导入角色 │ {importStageLabel(state.stage)}</span>
        <span className={styles.pct}>
          {pct}
          <small>%</small>
        </span>
      </div>
      <span className={styles.bar} aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}
