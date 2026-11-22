import type { CSSProperties } from 'react';
import { MicroLabel } from '../../ui/game';
import styles from './Status.module.css';

const CELLS = 8;

/** One import or sync in eight cells, the cell it is in filled as far as it got. */
function Cells({ label, fraction }: { label: string; fraction: number }) {
  const f = Math.min(1, Math.max(0, fraction));
  return (
    <span className={styles.cells} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(f * 100)}>
      {Array.from({ length: CELLS }, (_, i) => (
        <i key={i} style={{ '--f': Math.min(1, Math.max(0, f * CELLS - i)) } as CSSProperties} />
      ))}
    </span>
  );
}

export type StatusLine =
  | { kind: 'import'; title: string | null; stage: string; fraction: number }
  | { kind: 'sync'; who: string; stage: string; done: number; total: number; fraction: number }
  | { kind: 'note'; ok: boolean; text: string };

/** 库顶状态条：同一格一次只说一件事（导入 > 同步 > 上次导入的结果）。 */
export function Status({ line }: { line: StatusLine }) {
  if (line.kind === 'note')
    return (
      <div className={styles.status} data-tone={line.ok ? undefined : 'danger'}>
        <span className={styles.l1} data-motion-import="" role="status">
          {line.text}
        </span>
      </div>
    );
  const pct = `${Math.round(Math.min(1, Math.max(0, line.fraction)) * 100)}%`;
  const sync = line.kind === 'sync';
  const label = sync && line.total > 0 ? `${line.stage} ${line.done}/${line.total}` : line.stage;
  return (
    <div className={styles.status} role="status" aria-label={sync ? 'MMD 同步' : 'MMD 导入'}>
      <span className={styles.l1}>
        <span className={styles.what}>{sync ? `同步曲库到 ${line.who}` : line.title ? `正在导入「${line.title}」` : '正在导入'}</span>
        <span className={styles.st}>{line.stage}</span>
        <MicroLabel>{sync ? 'SYNC' : 'IMPORT'}</MicroLabel>
        <span className={styles.sp} />
        {sync && line.total > 0 && <span className={styles.dn}>{`${line.done}/${line.total}`}</span>}
        <span className={styles.pc}>{pct}</span>
      </span>
      <Cells label={label} fraction={line.fraction} />
    </div>
  );
}
