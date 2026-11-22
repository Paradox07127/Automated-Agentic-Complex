import { useState } from 'react';
import { formatClock } from '../../../domain';
import type { BlockedLine } from '../diag';
import styles from '../groups.module.css';

/** The proactive kinds agentd may mute (proactive.py `MUTABLE`). */
export const MUTED_KIND: Record<string, string> = {
  comment: '久盯一个窗口时搭话',
  back: '回来时汇报',
  break: '休息提示',
  water: '喝水提示',
  stuck: '卡住时问要不要帮忙',
  thought: '冒出的想法',
  session: '会话出事时告诉你',
  task: '任务停了时提醒',
  repeat: '重复的事建议做成定时任务',
};

/** Gate categories: the mutable kinds plus the announcements that pass the gate below P0. */
export const GATE_KIND: Record<string, string> = {
  ...MUTED_KIND,
  dispatch_closed: '派的活过期了，没有开始',
  dispatch_failed: '派的任务没做成',
  dispatch_review: '派的任务回话了，结果要确认',
  session_failed: '会话出错了',
  task_expired: '任务没开始就过期了',
  task_interrupted: '任务被重启打断了',
  focus_done: '专注时段结束',
  reminder_missed: '错过的提醒',
};

/** gate.py `_reason` codes, and the ones proactive.py reports for a line it holds before the gate. */
const REASON: Record<string, string> = {
  disabled: '主动说话关着',
  companion_off: '陪伴类关着',
  muted: '这一类被关掉了',
  meeting: '在开会',
  focus: '在专注时段',
  user_speaking: '你正在说话',
  fullscreen: '在全屏',
  quiet_hours: '在免打扰时段',
  daily_limit: '今天的次数用完了',
  same_cooldown: '同类刚说过',
  cross_cooldown: '刚说过别的',
  short_away: '离开没多久',
  no_before_away: '离开期间没有要报的事',
  cannot_interrupt: '现在不便打断',
  busy: '角色正忙',
};

/** Today's blocked lines behind a fold, one row each: time, kind, reason. */
export function GateBlocked({ lines }: { lines: BlockedLine[] }) {
  const [open, setOpen] = useState(false);
  if (lines.length === 0) return null;
  return (
    <>
      <button type="button" className={styles.blockedFold} aria-expanded={open} aria-controls="set-gate-blocked" onClick={() => setOpen(!open)}>
        今天拦截 <span className="num">{lines.length}</span> 条
      </button>
      {open && (
        <div id="set-gate-blocked" className={styles.blocked} role="list" aria-label="今天拦截的发言">
          {lines.map((l, i) => (
            <span key={`${l.t}-${i}`} role="listitem" className={styles.blockedRow}>
              <span className="num">{formatClock(l.t)}</span>
              <span>{GATE_KIND[l.kind] ?? l.kind}</span>
              <span className={styles.t3}>{REASON[l.reason] ?? l.reason}</span>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
