import { WEEKDAYS, type Schedule, type ScheduleTrigger } from '../../domain/schedules';
import { Btn, Dialog, Seg } from '../../ui';
import styles from './Page.module.css';

export interface ScheduleDraft {
  scheduleId: string | null;
  title: string;
  instruction: string;
  kind: ScheduleTrigger['kind'];
  at: string;
  weekdays: number[];
  weekday: number;
  target: 'claude' | 'codex' | null;
  project: string;
  scopeId: string | null;
  conversationId: string | null;
}

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function emptyDraft(): ScheduleDraft {
  return {
    scheduleId: null,
    title: '',
    instruction: '',
    kind: 'daily',
    at: '18:30',
    weekdays: [1, 2, 3, 4, 5],
    weekday: 5,
    target: null,
    project: '',
    scopeId: null,
    conversationId: null,
  };
}

export function draftFromSchedule(s: Schedule): ScheduleDraft {
  const t = s.trigger;
  return {
    scheduleId: s.schedule_id,
    title: s.title,
    instruction: s.instruction,
    kind: t.kind,
    at: t.kind === 'session_done' ? '18:30' : t.at,
    weekdays: t.kind === 'daily' ? [...t.weekdays] : [1, 2, 3, 4, 5],
    weekday: t.kind === 'weekly' ? t.weekday : 5,
    target: t.kind === 'session_done' ? t.target : null,
    project: t.kind === 'session_done' && t.project ? t.project : '',
    scopeId: s.scope_id,
    conversationId: s.conversation_id,
  };
}

export function triggerFromDraft(d: ScheduleDraft): ScheduleTrigger | null {
  if (d.kind === 'session_done') {
    const project = d.project.trim() ? d.project.trim() : null;
    return { kind: 'session_done', target: d.target, project };
  }
  if (!TIME_RE.test(d.at.trim())) return null;
  const at = d.at.trim();
  if (d.kind === 'daily') {
    const weekdays = [...new Set(d.weekdays)].filter((x) => x >= 1 && x <= 7).sort((a, b) => a - b);
    if (weekdays.length === 0) return null;
    return { kind: 'daily', at, weekdays };
  }
  if (d.weekday < 1 || d.weekday > 7) return null;
  return { kind: 'weekly', at, weekday: d.weekday };
}

export interface ScheduleDialogProps {
  draft: ScheduleDraft | null;
  saving: boolean;
  onChange: (next: ScheduleDraft) => void;
  onClose: () => void;
  onSave: () => void;
  scopes: ReadonlyArray<{ id: string; label: string }>;
  conversations: ReadonlyArray<{ id: string; label: string }>;
  optionsState: 'pending' | 'error' | 'success';
  onRetry: () => void;
}

export function ScheduleDialog({ draft, saving, onChange, onClose, onSave, scopes, conversations, optionsState, onRetry }: ScheduleDialogProps) {
  if (!draft) return null;
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...draft, ...patch });
  const trigger = triggerFromDraft(draft);
  const valid = draft.title.trim().length > 0 && draft.instruction.trim().length > 0 && trigger !== null;
  const scopeMissing = draft.scopeId !== null && !scopes.some((s) => s.id === draft.scopeId);
  const conversationMissing = draft.conversationId !== null && !conversations.some((s) => s.id === draft.conversationId);

  const toggleWeekday = (day: number) => {
    const has = draft.weekdays.includes(day);
    if (has && draft.weekdays.length <= 1) return;
    const next = has ? draft.weekdays.filter((d) => d !== day) : [...draft.weekdays, day].sort((a, b) => a - b);
    set({ weekdays: next });
  };

  return (
    <Dialog
      open
      title={draft.scheduleId ? '编辑定时任务' : '新建定时任务'}
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>
            取消
          </Btn>
          <Btn
            variant="primary"
            loading={saving}
            disabled={!valid}
            disabledReason="请填写标题、指令与合法的触发条件"
            onClick={onSave}
          >
            保存
          </Btn>
        </>
      }
    >
      <div className={styles.form}>
        <label className={styles.field}>
          <span>标题</span>
          <input
            aria-label="标题"
            className={styles.input}
            value={draft.title}
            placeholder="例如：每日代码变更小结"
            onChange={(e) => set({ title: e.target.value })}
          />
        </label>
        <label className={styles.field}>
          <span>指令</span>
          <textarea
            aria-label="指令"
            className={styles.textarea}
            rows={2}
            value={draft.instruction}
            placeholder="交给后台作业执行的说明"
            onChange={(e) => set({ instruction: e.target.value })}
          />
        </label>
        <div className={styles.field}>
          <span>触发条件</span>
          <Seg
            label="触发条件"
            value={draft.kind}
            onChange={(v) => set({ kind: v as ScheduleTrigger['kind'] })}
            options={[
              { value: 'daily', label: '按日重复' },
              { value: 'weekly', label: '每周一次' },
              { value: 'session_done', label: '会话结束后' },
            ]}
          />
        </div>
        {draft.kind !== 'session_done' && (
          <div className={styles.when}>
            <label className={styles.field}>
              <span>时间</span>
              <input
                aria-label="时间"
                className={`${styles.input} ${styles.timeInput}`}
                value={draft.at}
                placeholder="18:30"
                onChange={(e) => set({ at: e.target.value })}
              />
            </label>
            <div className={styles.field}>
              <span>星期</span>
              <div className={styles.weekdays} role="group" aria-label={draft.kind === 'daily' ? '重复星期' : '执行星期'}>
                {WEEKDAYS.map((w) => (
                  <button
                    key={w.day}
                    type="button"
                    className={styles.dayBtn}
                    aria-pressed={draft.kind === 'daily' ? draft.weekdays.includes(w.day) : draft.weekday === w.day}
                    aria-label={`周${w.label}`}
                    onClick={() => draft.kind === 'daily' ? toggleWeekday(w.day) : set({ weekday: w.day })}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {draft.kind === 'session_done' && (
          <>
            <div className={styles.field}>
              <span>编码工具</span>
              <Seg
                size="sm"
                label="编码工具"
                value={draft.target ?? 'all'}
                onChange={(v) => set({ target: v === 'all' ? null : (v as 'claude' | 'codex') })}
                options={[
                  { value: 'all', label: '不限' },
                  { value: 'claude', label: 'Claude Code' },
                  { value: 'codex', label: 'Codex' },
                ]}
              />
            </div>
            <label className={styles.field}>
              <span>项目（可选）</span>
              <input
                aria-label="项目"
                className={styles.input}
                value={draft.project}
                placeholder="留空则匹配所有项目"
                onChange={(e) => set({ project: e.target.value })}
              />
            </label>
          </>
        )}
        <div className={styles.contextFields}>
          <label className={styles.field}>
            <span>授权资料</span>
            <select className={styles.input} value={draft.scopeId ?? ''} onChange={(e) => set({ scopeId: e.target.value || null })}>
              <option value="">不读取资料</option>
              {scopeMissing && <option value={draft.scopeId!}>原授权当前不可用</option>}
              {scopes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span>关联对话</span>
            <select className={styles.input} value={draft.conversationId ?? ''} onChange={(e) => set({ conversationId: e.target.value || null })}>
              <option value="">独立任务</option>
              {conversationMissing && <option value={draft.conversationId!}>原对话当前不可用</option>}
              {conversations.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
        </div>
        {optionsState === 'pending' && <span role="status">正在读取可关联的资料和对话…</span>}
        {optionsState === 'error' && <Btn size="sm" variant="secondary" onClick={onRetry}>重试读取资料和对话</Btn>}
        <small>任务只使用这里选定的资料和对话。授权到期或撤销后，对应运行会暂停。</small>
      </div>
    </Dialog>
  );
}
