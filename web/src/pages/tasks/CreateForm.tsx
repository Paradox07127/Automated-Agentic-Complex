import type { PickedHandle } from '../../bridge/protocol';
import type { Goal } from '../../domain';
import { Btn, InfoTip, Seg, Select } from '../../ui';
import styles from './CreateForm.module.css';

export type CreateKind = 'role' | 'code';

/** own.py MODES. */
export type CodeMode = 'read_only' | 'workspace_write';

export interface CreateDraft {
  kind: CreateKind;
  title: string;
  brief: string;
  goalId: string;
  acceptanceOpen: boolean;
  /** Relative path of the expected artifact. */
  artifact: string;
  sections: string;
  agent: 'claude' | 'codex';
  /** Folder handle from the native picker; the bridge turns it into the path. */
  cwd: PickedHandle | null;
  mode: CodeMode;
  /** Scope a role task may read (`scope_id`); null leaves agentd's default. */
  scopeId: string | null;
}

export function draftFor(kind: CreateKind): CreateDraft {
  return {
    kind,
    title: '',
    brief: '',
    goalId: '',
    acceptanceOpen: false,
    artifact: '',
    sections: '',
    agent: 'claude',
    cwd: null,
    mode: 'read_only',
    scopeId: null,
  };
}

/** What each mode lets the coding tool do (own.py MODES: Claude permission mode, Codex sandbox). */
const MODE_NOTE: Record<CodeMode, string> = {
  read_only: 'Claude 每次改动都要你批准；Codex 在只读沙箱里运行',
  workspace_write: 'Claude 自动接受改动；Codex 可以改这个目录里的文件',
};

export interface CreateFormProps {
  draft: CreateDraft;
  onChange: (d: CreateDraft) => void;
  goals: Goal[];
  /** Bridge has `nativeFilePicker`. */
  canPick: boolean;
  onPickFolder: () => void;
}

/** 新建：类型由菜单项预选；角色任务写标题、要求和验收条件，编码任务选工具、目录和权限。 */
export function CreateForm({ draft, onChange, goals, canPick, onPickFolder }: CreateFormProps) {
  const set = (patch: Partial<CreateDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className={styles.root} data-nav-target="task-create">
      <Seg
        label="新建类型"
        value={draft.kind}
        onChange={(v) => set({ kind: v as CreateKind })}
        options={[
          { value: 'role', label: '角色任务' },
          { value: 'code', label: '编码会话' },
        ]}
      />
      {draft.kind === 'role' && (
        <label className={styles.field}>
          <span>标题</span>
          <input className={styles.input} placeholder="给任务起个名字" value={draft.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
      )}
      <label className={styles.field}>
        <span>要求</span>
        <textarea className={styles.input} rows={3} placeholder="要做什么，做到什么程度？" value={draft.brief} onChange={(e) => set({ brief: e.target.value })} />
      </label>
      {draft.kind === 'role' && (
        <>
          <div className={styles.field}>
            <span>关联目标</span>
            <Select
              label="关联目标"
              value={draft.goalId}
              onChange={(v) => set({ goalId: v })}
              options={[{ value: '', label: '不关联' }, ...goals.map((g) => ({ value: g.id, label: g.title }))]}
            />
          </div>
          <div className={styles.acc}>
            <button type="button" className={styles.fold} aria-expanded={draft.acceptanceOpen} onClick={() => set({ acceptanceOpen: !draft.acceptanceOpen })}>
              {draft.acceptanceOpen ? '▾' : '▸'} 验收条件{!draft.acceptanceOpen && draft.artifact.trim() ? ` │ ${draft.artifact.trim()}` : ''}
            </button>
            {draft.acceptanceOpen && (
              <>
                <label className={styles.field}>
                  <span className={styles.label}>
                    预期产物
                    <InfoTip>相对于产物文件夹的路径，后缀 md、txt、csv 或 json。</InfoTip>
                  </span>
                  <input className={`${styles.input} ${styles.mono}`} placeholder="例如：汇总.md" value={draft.artifact} onChange={(e) => set({ artifact: e.target.value })} />
                </label>
                <label className={styles.field}>
                  <span>必须包含的章节</span>
                  <input className={styles.input} value={draft.sections} onChange={(e) => set({ sections: e.target.value })} />
                </label>
                <p className={styles.note}>不填预期产物时，结果保留为待复核</p>
              </>
            )}
          </div>
        </>
      )}
      {draft.kind === 'code' && (
        <>
          <div className={styles.field}>
            <span>编码工具</span>
            <Seg
              size="sm"
              label="编码工具"
              value={draft.agent}
              onChange={(v) => set({ agent: v as CreateDraft['agent'] })}
              options={[
                { value: 'claude', label: 'Claude' },
                { value: 'codex', label: 'Codex' },
              ]}
            />
          </div>
          <div className={styles.field}>
            <span>目录</span>
            <span className={styles.line}>
              <input className={`${styles.input} ${styles.mono}`} value={draft.cwd?.displayName ?? ''} placeholder="还没有选目录" readOnly aria-label="目录" />
              <Btn size="sm" variant="ghost" icon="folder" disabled={!canPick} disabledReason="这台电脑的外壳不支持原生目录选择" onClick={onPickFolder}>
                选择…
              </Btn>
            </span>
          </div>
          <div className={styles.field}>
            <span>权限</span>
            <Select
              label="权限"
              value={draft.mode}
              onChange={(v) => set({ mode: v as CodeMode })}
              options={[
                { value: 'read_only', label: '只读' },
                { value: 'workspace_write', label: '允许改动目录内文件', risky: true },
              ]}
            />
            <span className={styles.note}>{MODE_NOTE[draft.mode]}</span>
          </div>
        </>
      )}
    </div>
  );
}
