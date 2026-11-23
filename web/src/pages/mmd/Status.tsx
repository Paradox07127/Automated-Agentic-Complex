import { LoadBar, MicroLabel, StatusLamp } from '../../ui/game';
import styles from './Status.module.css';

export type StatusLine =
  | { kind: 'import'; title: string | null; stage: string; fraction: number }
  | { kind: 'sync'; who: string; stage: string; done: number; total: number; fraction: number }
  | { kind: 'note'; ok: boolean; text: string };

/** 库顶状态条：同一格一次只说一件事（导入 > 同步 > 上次导入的结果）。 */
export function Status({ line }: { line: StatusLine }) {
  if (line.kind === 'note')
    return (
      <div className={styles.status}>
        <span className={styles.l1} data-motion-import="" role="status">
          <StatusLamp onDark wrap state={line.ok ? 'done' : 'failed'} label={line.text} />
        </span>
      </div>
    );
  const sync = line.kind === 'sync';
  return (
    <div className={styles.status} role="status" aria-label={sync ? 'MMD 同步' : 'MMD 导入'}>
      <span className={styles.l1}>
        <span className={styles.what}>{sync ? `同步曲库到 ${line.who}` : line.title ? `正在导入「${line.title}」` : '正在导入'}</span>
        <StatusLamp onDark state="running" label={line.stage} />
        <MicroLabel>{sync ? 'SYNC' : 'IMPORT'}</MicroLabel>
        <span className={styles.sp} />
        {sync && line.total > 0 && <span className={styles.dn}>{`${line.done}/${line.total}`}</span>}
      </span>
      <LoadBar fraction={line.fraction} />
    </div>
  );
}
