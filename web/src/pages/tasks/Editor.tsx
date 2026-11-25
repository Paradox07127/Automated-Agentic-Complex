// The editor in the detail column: 派发任务 (role task or coding session, now or on a schedule), 新建 / 编辑定时任务.
import type { ReactNode } from 'react';
import { WEEKDAYS } from '../../domain/schedules';
import { usePlugins } from '../../shell/plugins';
import { Btn, Field, Fold, TextArea } from '../../ui';
import { GameSeg, MicroLabel } from '../../ui/game';
import { draftNext, type EditDraft } from './draft';
import { Clock } from './Glyphs';
import { dayText, spanText, type Choice } from './schedules';
import detail from './Detail.module.css';
import styles from './Editor.module.css';

/** What each mode lets the coding tool do (own.py MODES: Claude permission mode, Codex sandbox). */
const MODE_NOTE = {
  read_only: 'Claude Code 每次修改均须手动批准；Codex 运行于只读沙箱',
  workspace_write: 'Claude Code 自动接受修改；Codex 允许修改当前目录内文件',
} as const;

export interface EditorProps {
  draft: EditDraft;
  onChange: (d: EditDraft) => void;
  /** The role's name in 交给谁. */
  who: string;
  scopes: Choice[] | null;
  conversations: Choice[] | null;
  canPick: boolean;
  onPickFolder: () => void;
  problem: string | null;
  now: number;
}

function Row({ label, note, top, children }: { label: string; note?: string; top?: boolean; children: ReactNode }) {
  return (
    <div className={styles.fr} data-top={top || undefined}>
      <span className={styles.lbl}>
        {label}
        {note && <small>{note}</small>}
      </span>
      <div className={styles.ctl}>{children}</div>
    </div>
  );
}

function Pick({ label, value, options, onChange, missing }: { label: string; value: string | null; options: Choice[] | null; onChange: (v: string | null) => void; missing: string }) {
  const gone = value != null && options != null && !options.some((o) => o.id === value);
  return (
    <span className={styles.dd}>
      <select aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        {options == null && value != null && <option value={value}>读取中…</option>}
        <option value="">{missing}</option>
        {gone && <option value={value}>原选项当前不可用</option>}
        {(options ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

export function Editor({ draft: d, onChange, who, scopes, conversations, canPick, onPickFolder, problem, now }: EditorProps) {
  const set = (patch: Partial<EditDraft>) => onChange({ ...d, ...patch });
  const codeOn = usePlugins().coding_sessions;
  const repeat = d.when === 'repeat';
  const role = d.type === 'role';
  const title = d.scheduleId ? '编辑定时任务' : repeat ? '新建定时任务' : '派发任务';
  const next = repeat && d.trig !== 'session_done' ? draftNext(d, now) : null;
  const toggleDay = (w: number) => {
    if (d.trig === 'weekly') return set({ weekday: w });
    const has = d.weekdays.includes(w);
    if (has && d.weekdays.length <= 1) return;
    set({ weekdays: has ? d.weekdays.filter((x) => x !== w) : [...d.weekdays, w].sort((a, b) => a - b) });
  };
  return (
    <>
      <div className={detail.head}>
        <div className={detail.kind}>
          <i aria-hidden="true" />
          <MicroLabel>{d.scheduleId ? 'Edit Schedule' : repeat ? 'New Schedule' : 'Dispatch'}</MicroLabel>
        </div>
        <div className={detail.trow}>
          <h2>{title}</h2>
        </div>
        <div className={detail.meta}>
          <span>{repeat ? '保存后将按计划自动执行，可随时通过开关停用' : '派发后可在「进行中」列表查看执行进度'}</span>
        </div>
        <div className={detail.sep} />
      </div>
      <div className={detail.scroll}>
        <div className={styles.form} role="form" aria-label={title} data-nav-target="task-create">
          {!d.scheduleId && (
            <Row label="执行主体">
              <GameSeg label="执行主体" value={d.type} options={[{ value: 'role', label: `${who}（角色任务）` }, ...(codeOn ? [{ value: 'code', label: '编码会话' }] : [])]} onChange={(v) => set({ type: v as EditDraft['type'], ...(v === 'code' ? { when: 'now' as const } : {}) })} />
            </Row>
          )}
          {role && !d.scheduleId && (
            <Row label="执行方式">
              <GameSeg label="执行方式" value={d.when} options={[{ value: 'now', label: '立即执行' }, { value: 'repeat', label: '定时重复' }]} onChange={(v) => set({ when: v as EditDraft['when'] })} />
            </Row>
          )}
          {role && (
            <Row label="标题">
              <Field label="标题" value={d.title} placeholder={repeat ? '例如：每日代码变更小结' : '请输入任务标题'} onChange={(v) => set({ title: v })} />
            </Row>
          )}
          <Row label={repeat ? '执行指令' : '任务要求'} note={repeat ? '每次触发均按此指令执行' : '请描述任务目标与完成标准'} top>
            <TextArea label={repeat ? '执行指令' : '任务要求'} rows={3} value={d.brief} placeholder={repeat ? '提供给定时任务的执行指令' : '请描述具体任务内容与预期完成标准'} onChange={(v) => set({ brief: v })} />
          </Row>
          {!role && (
            <>
              <Row label="编码工具">
                <GameSeg label="编码工具" value={d.agent} options={[{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]} onChange={(v) => set({ agent: v as EditDraft['agent'] })} />
              </Row>
              <Row label="目录">
                <span className={styles.dir}>
                  <Field label="目录" mono readOnly value={d.cwd?.displayName ?? ''} placeholder="尚未选择目录" />
                </span>
                <Btn size="sm" variant="ghost" icon="folder" disabled={!canPick} disabledReason="当前客户端环境暂不支持原生目录选择" onClick={onPickFolder}>
                  选择…
                </Btn>
              </Row>
              <Row label="权限" note={MODE_NOTE[d.mode]}>
                <span className={styles.dd}>
                  <select aria-label="权限" value={d.mode} onChange={(e) => set({ mode: e.target.value as EditDraft['mode'] })}>
                    <option value="read_only">只读</option>
                    <option value="workspace_write">允许改动目录内文件</option>
                  </select>
                </span>
              </Row>
            </>
          )}
          {repeat && (
            <Row label="触发">
              <GameSeg
                label="触发"
                value={d.trig}
                options={[{ value: 'daily', label: '按星期重复' }, { value: 'weekly', label: '每周一次' }, { value: 'session_done', label: '编码会话结束后' }]}
                onChange={(v) => set({ trig: v as EditDraft['trig'] })}
              />
            </Row>
          )}
          {repeat && d.trig !== 'session_done' && (
            <Row label="时间">
              <span className={styles.time}>
                <Field label="时间" value={d.at} placeholder="18:30" onChange={(v) => set({ at: v })} />
              </span>
              <span className={styles.days} role="group" aria-label={d.trig === 'daily' ? '重复星期' : '执行星期'}>
                {WEEKDAYS.map((w) => {
                  const on = d.trig === 'daily' ? d.weekdays.includes(w.day) : d.weekday === w.day;
                  return (
                    <Btn key={w.day} size="sm" variant={on ? 'ghost' : 'secondary'} label={`周${w.label}`} pressed={on} onClick={() => toggleDay(w.day)}>
                      {w.label}
                    </Btn>
                  );
                })}
              </span>
            </Row>
          )}
          {repeat && d.trig === 'session_done' && (
            <Row label="触发工具">
              <GameSeg label="触发工具" value={d.target ?? 'all'} options={[{ value: 'all', label: '不限' }, { value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]} onChange={(v) => set({ target: v === 'all' ? null : (v as 'claude' | 'codex') })} />
              <span className={styles.project}>
                <Field label="项目" value={d.project} placeholder="项目名，留空匹配所有项目" onChange={(v) => set({ project: v })} />
              </span>
            </Row>
          )}
          {role && (
            <Row label="授权资料" note={repeat ? '仅限读取所选范围；过期后自动暂停' : '仅限读取所选范围'}>
              <Pick label="授权资料" value={d.scopeId} options={scopes} missing="未关联资料范围" onChange={(v) => set({ scopeId: v })} />
            </Row>
          )}
          {repeat && (
            <Row label="关联对话">
              <Pick label="关联对话" value={d.conversationId} options={conversations} missing="独立定时任务" onChange={(v) => set({ conversationId: v })} />
            </Row>
          )}
          {role && !repeat && (
            <Fold label="验收条件" summary={d.artifact.trim() || undefined}>
              <div className={styles.form}>
                <Row label="预期产物" note="相对于产物输出目录；支持 md / txt / csv / json">
                  <Field label="预期产物" mono value={d.artifact} placeholder="例如：汇总.md" onChange={(v) => set({ artifact: v })} />
                </Row>
                <Row label="必须包含的章节">
                  <Field label="必须包含的章节" value={d.sections} placeholder="用顿号（、）分隔" onChange={(v) => set({ sections: v })} />
                </Row>
              </div>
            </Fold>
          )}
        </div>
        {repeat && (
          <div className={styles.preview}>
            <Clock size={18} />
            {d.trig === 'session_done' ? (
              <b>下一次：{d.target === 'codex' ? 'Codex' : d.target === 'claude' ? 'Claude Code' : '编码工具'}{d.project.trim() ? ` 在 ${d.project.trim()}` : ''} 的会话结束时</b>
            ) : next != null ? (
              <b>
                下一次：{dayText(next, now)} │ 还有 {spanText(next - now)}
              </b>
            ) : (
              <span className={styles.err}>时间写成 18:30 这样，至少选一天</span>
            )}
          </div>
        )}
        {problem && (
          <p className={styles.err} role="status">
            {problem}
          </p>
        )}
      </div>
    </>
  );
}
