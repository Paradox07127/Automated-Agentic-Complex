import { ActionBar, Diamond, WhiteCapsule, YellowKey } from '../../../ui/game';
import styles from './Chain.module.css';

export interface CommitBarProps {
  offline: boolean;
  /** Unsaved changes. */
  n: number;
  /** What they are, by kind: 「池 idle.t1」「混合 cough_end」. */
  parts: string[];
  saving: boolean;
  onUndo: () => void;
  onSave: () => void;
}

/** 提交条（面板底，整屏唯一的保存）：未保存几项和分类，全部撤销、保存；没有改动时只写「已保存」。 */
export function CommitBar(p: CommitBarProps) {
  const live = !p.offline && p.n > 0;
  return (
    <div className={styles.commit} data-commit="">
      <ActionBar
        label="保存动作设置"
        micro="Commit"
        left={
          p.offline ? (
            <span className={styles.st}>角色未运行 │ 只读</span>
          ) : p.n > 0 ? (
            <span className={styles.st}>
              <Diamond tone="yellow" size={8} />
              未保存 <b>{p.n}</b> 项<span className={styles.parts}>│ {p.parts.join(' │ ')}</span>
            </span>
          ) : (
            <span className={styles.st} data-quiet="">
              已保存
            </span>
          )
        }
        {...(live
          ? {
              right: (
                <>
                  <WhiteCapsule label="全部撤销" icon="refresh" disabled={p.saving} onClick={p.onUndo} />
                  <YellowKey label="保存" icon="check" micro="Save" busy={p.saving} onClick={p.onSave} />
                </>
              ),
            }
          : {})}
      />
    </div>
  );
}
