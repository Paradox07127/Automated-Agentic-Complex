// One schedule (MissionInfoNode): ON/OFF, the trigger on the location line, the last run; her proposal as a paper, the
// failed last run as a red band, the next run as the TimerNode band, the instruction and what it uses.
import type { Schedule } from '../../domain/schedules';
import { Btn, SecHead } from '../../ui';
import { GameSeg, MicroLabel } from '../../ui/game';
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

export function ScheduleDetail({ s, now, scopes, convTitle, onToggle, onEdit, onDecline, onOpenJob, onGoChat }: ScheduleDetailProps) {
  const proposal = s.created_from === 'agent_proposal' && !s.enabled;
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
            <span className={styles.chip} data-k="off">
              <i aria-hidden="true" />
              未启用
            </span>
          ) : (
            <GameSeg label={`启用「${s.title}」`} variant="onoff" value={s.enabled ? 'on' : 'off'} options={[{ value: 'on', label: '开' }, { value: 'off', label: '关' }]} onChange={(v) => onToggle(v === 'on')} />
          )}
        </div>
        <div className={styles.where}>
          <Pin />
          <span>
            {triggerText(t)}
            {s.created_from === 'agent_proposal' ? ' │ 她提议的' : ''}
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
                    看那次任务
                  </Btn>
                </>
              )}
            </span>
          ) : (
            <span>还没跑过</span>
          )}
        </div>
        <div className={styles.sep} />
      </div>
      <div className={styles.scroll}>
        {proposal && (
          <div className={paper.paper} data-depth="" data-theme="light">
            <h4>她提议：{triggerText(t)} {s.title}</h4>
            <p>启用后按时自己跑{scope ? `，读「${scope.label}」` : ''}。</p>
            <div className={paper.btns}>
              <Btn size="sm" variant="primary" onClick={() => onToggle(true)}>
                启用
              </Btn>
              <Btn size="sm" variant="secondary" onClick={onDecline}>
                不要
              </Btn>
              <span className={paper.sp} />
              <Btn size="sm" variant="text" onClick={onEdit}>
                先编辑
              </Btn>
            </div>
          </div>
        )}
        {s.last_error && (
          <div className={page.tipsR} role="status">
            <Warn />
            <span>
              <b>上次没跑成</b>
              <small>{scheduleError(s.last_error) ?? '上次运行没提交成功，再试一次或查看诊断'}</small>
            </span>
            <Btn size="sm" variant="ghost" onClick={onEdit}>
              重新选资料
            </Btn>
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
                还有 <b className="num">{spanText(s.next_run_at - now)}</b>
              </span>
            )}
          </div>
        )}
        <p className={styles.desc}>{s.instruction}</p>
        <SecHead title="用到的" />
        <div className={styles.kv}>
          <div>
            <span>授权资料</span>
            <b className="num">{s.scope_id ? (scope?.label ?? (scopes ? '原授权当前不可用' : '—')) : '不读资料'}</b>
            <em className="num">{scope ? `${new Date(scope.expires).getMonth() + 1}.${new Date(scope.expires).getDate()} 到期` : ''}</em>
          </div>
          <div>
            <span>关联对话</span>
            <b>{s.conversation_id ? `「${convTitle(s.conversation_id) ?? '对话'}」` : '独立任务'}</b>
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
