// One schedule (MissionInfoNode): ON/OFF, the trigger on the location line, the last run; her proposal as a paper, the
// failed last run as a red band, the next run as the TimerNode band, the instruction and what it uses.
import type { Schedule } from '../../domain/schedules';
import { Btn, Pill, SecHead, Switch } from '../../ui';
import { MicroLabel } from '../../ui/game';
import { Clock, Pin, Warn } from './Glyphs';
import { dayText, scheduleError, spanText, triggerText, type Choice } from './schedules';
import page from './Page.module.css';
import paper from './Paper.module.css';
import styles from './Detail.module.css';

export interface ScheduleDetailProps {
  s: Schedule;
  now: number;
  scopes: ReadonlyArray<Choice & { expires: number }> | null;
  convTitle: (id: string) => string | null;
  onToggle: (on: boolean) => void;
  onEdit: () => void;
  onDecline: () => void;
  onOpenJob: (taskId: string) => void;
  onGoChat: (id: string) => void;
}

const SCOPE_ERR = new Set(['scope_expired', 'scope_revoked', 'unknown_scope', 'scope_changed']);

export function ScheduleDetail({ s, now, scopes, convTitle, onToggle, onEdit, onDecline, onOpenJob, onGoChat }: ScheduleDetailProps) {
  const proposal = s.created_from === 'agent_proposal' && s.accepted_at == null;
  const scope = s.scope_id ? scopes?.find((x) => x.id === s.scope_id) : null;
  const t = s.trigger;
  return (
    <>
      <div className={styles.head}>
        <div className={styles.kind}>
          <i aria-hidden="true" />
          <MicroLabel>{`Schedule / ${s.schedule_id.slice(-6)}`}</MicroLabel>
        </div>
        <div className={styles.trow}>
          <h2 title={s.title}>{s.title}</h2>
          {proposal ? (
            <Pill size="lg">
              <span aria-hidden="true">□</span>
              未启用
            </Pill>
          ) : (
            <Switch label={`启用「${s.title}」`} checked={s.enabled} onChange={onToggle} />
          )}
        </div>
        <div className={styles.where}>
          <Pin />
          <span>
            {triggerText(t)}
            {s.created_from === 'agent_proposal' ? ' │ 由角色建议生成' : ''}
          </span>
        </div>
        <div className={styles.meta}>
          {s.last_run_at != null ? (
            <span>
              上次 <b>{dayText(s.last_run_at, now)}</b>
              {s.last_job_id && (
                <>
                  {' │ '}
                  <Btn size="sm" variant="text" onClick={() => onOpenJob(`job:${s.last_job_id}`)}>
                    查看该次任务
                  </Btn>
                </>
              )}
            </span>
          ) : (
            <span>尚未运行</span>
          )}
        </div>
        <div className={styles.sep} />
      </div>
      <div className={styles.scroll}>
        {proposal && (
          <div className={paper.paper} data-depth="" data-theme="light">
            <h4>角色建议：{triggerText(t)} {s.title}</h4>
            <p>启用后将按计划自动执行{scope ? `，并读取「${scope.label}」` : ''}。</p>
            <div className={paper.btns}>
              <Btn size="sm" variant="primary" onClick={() => onToggle(true)}>
                启用
              </Btn>
              <Btn size="sm" variant="secondary" onClick={onDecline}>
                忽略
              </Btn>
              <span className={paper.sp} />
              <Btn size="sm" variant="text" onClick={onEdit}>
                编辑后再启用
              </Btn>
            </div>
          </div>
        )}
        {s.last_error && (
          <div className={page.tipsR} role="status">
            <Warn />
            <span>
              <b>上次运行失败</b>
              <small>{scheduleError(s.last_error) ?? '上次执行未能成功提交，请重试或前往诊断页查看详情'}</small>
            </span>
            {SCOPE_ERR.has(s.last_error) && (
              <Btn size="sm" variant="ghost" onClick={onEdit}>
                重新选择资料
              </Btn>
            )}
          </div>
        )}
        {s.enabled && (
          <div className={styles.timer}>
            <Clock size={22} />
            <span>
              {s.next_run_at != null ? (
                <>
                  下一次 <b>{dayText(s.next_run_at, now)}</b>
                </>
              ) : t.kind === 'session_done' ? (
                `下一次：${t.target === 'codex' ? 'Codex' : t.target === 'claude' ? 'Claude Code' : '编码工具'}${t.project ? ` 在 ${t.project}` : ''} 的会话结束时`
              ) : (
                '下一次 —'
              )}
            </span>
            {s.next_run_at != null && (
              <span className={styles.r}>
                剩余 <b className="num">{spanText(s.next_run_at - now)}</b>
              </span>
            )}
          </div>
        )}
        <p className={styles.desc}>{s.instruction}</p>
        <SecHead title="关联配置" />
        <div className={styles.kv}>
          <div>
            <span>授权资料</span>
            <b className="num">{s.scope_id ? (scope?.label ?? (scopes ? '原授权当前不可用' : '—')) : '未关联资料范围'}</b>
            <em className="num">{scope ? `${new Date(scope.expires).getMonth() + 1}.${new Date(scope.expires).getDate()} 到期` : ''}</em>
          </div>
          <div>
            <span>关联对话</span>
            <b>{s.conversation_id ? `「${convTitle(s.conversation_id) ?? '对话'}」` : '独立定时任务'}</b>
            <em>
              {s.conversation_id && (
                <Btn size="sm" variant="text" onClick={() => onGoChat(s.conversation_id!)}>
                  打开
                </Btn>
              )}
            </em>
          </div>
        </div>
      </div>
    </>
  );
}
