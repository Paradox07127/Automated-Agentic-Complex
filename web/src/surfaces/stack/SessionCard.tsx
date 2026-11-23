import type { ReactNode } from 'react';
import { formatAgo } from '../../domain/time';
import { InSession, toolAction } from '../../features/approval';
import { Pill, type PillProps } from '../../ui';
import type { Act } from './actions';
import type { SessionGroup, SessionRow, SessionStatus } from './sessions';
import styles from './SessionCard.module.css';

export const STATUS_LABEL: Record<SessionStatus, string> = { needs_you: '待处理', error: '出错', done: '完成', running: '运行中', stale: '没有新动静' };

const STATUS_TONE: Record<SessionStatus, PillProps['tone']> = { needs_you: 'attention', error: 'danger', done: 'success', running: 'info', stale: 'neutral' };

const BACKEND_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', agentd: 'Agentic', character: 'Agentic' };

/** `刚刚`, `6 分前`, `1 小时前`, `22 天前`. */
export function ago(now: number, at: number): string {
  return formatAgo(now - at);
}

/** 会话卡：状态签、标题、后端、最后一步、更新时间；点头部在主窗口打开这个会话。挂在它上面的审批和提问画在头部下面，用紧凑版（InSession）。 */
export interface SessionCardProps {
  group: SessionGroup;
  now: number;
  act: Act;
  /** The approvals and questions on this session, already rendered. */
  children?: ReactNode;
}

/** 「运行 swift test」 for the current or last tool, else the session's activity. */
function actionText(row: SessionRow): string {
  if (!row.tool) return row.activity;
  const a = toolAction(row.tool, row.target);
  return [a.verb, a.target].filter(Boolean).join(' ');
}

export function SessionCard({ group, now, act, children }: SessionCardProps) {
  const { row, status } = group;
  const line = actionText(row);
  return (
    <section className={styles.card} data-session-id={row.id} data-status={status} aria-label={`会话：${row.title} │ ${STATUS_LABEL[status]}`}>
      <button type="button" className={styles.head} title="在主窗口打开这个会话" onClick={() => act({ type: 'open-session', sessionId: row.id, title: row.title })}>
        <Pill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>
        <span className={styles.title}>{row.title}</span>
        <span className={styles.backend}>{BACKEND_LABEL[row.backend] ?? row.backend}</span>
        <span className={`${styles.age} num`}>{ago(now, row.updatedAt)}</span>
        {/* Always there, so the card keeps its height while tools come and go. */}
        <span className={styles.line} data-action="" data-live={row.live && row.tool ? 'true' : 'false'} title={line || undefined}>
          {line || ' '}
        </span>
      </button>
      {children && (
        <div className={styles.attached}>
          <InSession.Provider value>{children}</InSession.Provider>
        </div>
      )}
    </section>
  );
}
