import type { FileEffect } from '../../domain';
import { ChartState } from '../../charts';
import styles from './FileImpact.module.css';

/** 文件影响清单：写 / 改两类徽标，按目录分组，旁画增删条。 */
export interface FileImpactProps {
  /** 写过、改过的文件 */
  files: FileEffect[];
  /** 读取状态 */
  status?: 'ok' | 'loading' | 'error';
  /** 点文件（打开） */
  onOpen?: (path: string) => void;
}

const OP: Record<FileEffect['op'], string> = { write: '写', modify: '改' };
const BAR_PX = 80;

function byDir(files: readonly FileEffect[]) {
  const groups = new Map<string, Array<FileEffect & { name: string }>>();
  for (const f of files) {
    const i = f.path.lastIndexOf('/');
    const dir = f.path.slice(0, i);
    groups.set(dir, [...(groups.get(dir) ?? []), { ...f, name: f.path.slice(i + 1) }]);
  }
  return [...groups.entries()];
}

export function FileImpact({ files, status = 'ok', onOpen }: FileImpactProps) {
  const max = Math.max(1, ...files.map((f) => (f.added ?? 0) + (f.removed ?? 0)));
  const count = (op: FileEffect['op']) => files.filter((f) => f.op === op).length;
  return (
    <div data-stub="FileImpact" className={styles.root}>
      <ChartState state={status === 'ok' && files.length === 0 ? 'empty' : status} emptyText="这次运行没有写文件" height={60} need={27}>
        <div className={styles.head}>
          {(['write', 'modify'] as const).map((op) => (
            <span key={op} className={styles.sum}>
              <span className={styles.op} data-op={op}>
                {OP[op]}
              </span>
              <span className="num">{count(op)}</span>
            </span>
          ))}
        </div>
        {byDir(files).map(([dir, fs]) => (
          <div key={dir} className={styles.group}>
            <div className={styles.dir}>{dir}/</div>
            {fs.map((f) => (
              <div key={f.path} className={styles.row}>
                <span className={styles.op} data-op={f.op}>
                  {OP[f.op]}
                </span>
                <button type="button" className={styles.name} title={f.path} onClick={() => onOpen?.(f.path)}>
                  {f.name}
                </button>
                <span className={styles.bar} role="img" aria-label={`增 ${f.added ?? 0} 行，删 ${f.removed ?? 0} 行`}>
                  <i className={styles.add} style={{ width: ((f.added ?? 0) / max) * BAR_PX }} />
                  <i className={styles.del} style={{ width: ((f.removed ?? 0) / max) * BAR_PX }} />
                </span>
                <span className={styles.diff}>
                  <span className={styles.plus}>+{f.added ?? 0}</span> <span className={styles.minus}>−{f.removed ?? 0}</span>
                </span>
              </div>
            ))}
          </div>
        ))}
      </ChartState>
    </div>
  );
}
