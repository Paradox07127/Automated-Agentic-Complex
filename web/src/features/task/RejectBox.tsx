import { useId, useState } from 'react';
import { Btn, Switch } from '../../ui';
import styles from './RejectBox.module.css';

/** 补充要求框：任务详情和对话抽屉共用；退回先展开这一框，补充要求为空时「退回并继续」禁用。 */
export interface RejectBoxProps {
  /** reject：退回这一版并继续；continue：运行中补一句要求 */
  mode?: 'reject' | 'continue';
  /** 当前选中的内核名，写在开关旁 */
  kernelName?: string;
  /** 初始补充要求 */
  initialNote?: string;
  /** 提交中 */
  busy?: boolean;
  /** 提交 */
  onSubmit?: (note: string, useCurrentKernel: boolean) => void;
  /** 收起（只有 reject 模式有） */
  onCancel?: () => void;
}

export function RejectBox({ mode = 'reject', kernelName, initialNote = '', busy, onSubmit, onCancel }: RejectBoxProps) {
  const [note, setNote] = useState(initialNote);
  const [useCur, setUseCur] = useState(true);
  const id = useId();
  const empty = note.trim() === '';
  return (
    <div data-stub="RejectBox" data-mode={mode} className={styles.root}>
      <label className={styles.field} htmlFor={id}>
        {mode === 'reject' ? '补充要求（驳回后角色据此继续，只作用于这张卡）' : '补充要求（只作用于这张卡）'}
      </label>
      <textarea
        id={id}
        className={styles.input}
        rows={mode === 'reject' ? 3 : 2}
        value={note}
        placeholder={mode === 'reject' ? '例如：统计表按作者再拆一列' : '例如：金额保留两位小数'}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className={styles.foot}>
        <Switch checked={useCur} label="使用当前选中的内核" onChange={setUseCur} />
        {kernelName && <span className={styles.kernel}>{kernelName}</span>}
        <span className={styles.sp} />
        {mode === 'reject' && onCancel && (
          <Btn variant="text" onClick={onCancel}>
            取消
          </Btn>
        )}
        <Btn
          variant={mode === 'reject' ? 'secondary' : 'ghost'}
          loading={busy}
          disabled={empty}
          disabledReason="先写补充要求"
          onClick={() => onSubmit?.(note.trim(), useCur)}
        >
          {mode === 'reject' ? '驳回并继续' : '继续'}
        </Btn>
      </div>
    </div>
  );
}

export const RejectBoxDemos: Array<{ name: string; props: RejectBoxProps }> = [
  { name: 'reject', props: { kernelName: 'Codex', onCancel: () => {} } },
  { name: 'filled', props: { kernelName: 'Codex', initialNote: '统计表加一列「涉及文件数」', onCancel: () => {} } },
  { name: 'continue', props: { mode: 'continue' } },
];
