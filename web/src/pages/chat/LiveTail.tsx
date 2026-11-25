import { codeText } from '../../domain/errorText';
import { navigate, type NavTarget } from '../../shell/nav';
import { Btn } from '../../ui';
import type { MessageMenuProps } from './MessageMenu';
import { SideMessage } from './SideMessage';
import { Head, TextMessage } from './TextMessage';
import type { LiveReply } from './useChatFeed';
import styles from './Messages.module.css';

export interface LiveTailProps extends MessageMenuProps {
  /** Lines sent from here whose turn is not in `/turns` yet. */
  replies: LiveReply[];
  roleName: string;
  /** Her head picture beside her live replies; without it the first character of `roleName`. */
  headUrl?: string | undefined;
  /** Her character id; not drawn, the head comes from `headUrl`. */
  roleId?: string | null;
  frontTitle: string | null;
  /** The feed lost events while a reply was coming in. */
  incomplete: boolean;
  /** 「已完成 · 通过」 for this conversation's latest run end, if one came by. */
  runEnd: string | null;
  onFront: () => void;
  onQueue: (text: string) => void;
  /** Why 派发任务 is off, else null. */
  queueOff?: string | null;
  /** Sends a failed line's text again as a new line. */
  onRetry: (reply: LiveReply) => void;
}

/** The one next step a failed reply offers for its code. */
const NEXT: Readonly<Record<string, { label: string; to: NavTarget }>> = {
  auth_expired: { label: '前往登录', to: { page: 'settings', group: 'kernel', item: 'kcur' } },
  native_login_required: { label: '前往登录', to: { page: 'settings', group: 'kernel', item: 'kcur' } },
  quota_exhausted: { label: '查看用量', to: { page: 'diag', tab: 'flow', item: 'usage' } },
};

/** Why a reply failed: the sentence for its run's or its line's code, else agentd's public_message. */
function failedOf(r: LiveReply): { reason: string; code: string | null } {
  const code = [r.failure?.code, r.error].find((c) => codeText(c)) ?? null;
  return { reason: codeText(code) ?? r.failure?.public_message ?? '未返回回复', code };
}

/** Typing bubble before her first character: three dots in her bubble; the words stay for screen readers. */
function Thinking({ roleName, headUrl }: { roleName: string; headUrl: string | undefined }) {
  return (
    <div className={styles.msg} data-first="" data-new="">
      <Head name={roleName} url={headUrl} />
      <div className={styles.stack}>
        <p className={`${styles.bub} ${styles.typing}`} data-first="">
          <i aria-hidden="true" />
          <i aria-hidden="true" />
          <i aria-hidden="true" />
          <span className={styles.sr}>思考中</span>
        </p>
      </div>
    </div>
  );
}

/** The end of the stream: each line sent here with its live reply, then the run end (end line) and a gap note (system band). */
export function LiveTail({ replies, roleName, headUrl, roleId: _roleId, frontTitle, incomplete, runEnd, onFront, onQueue, queueOff, onRetry, ...menu }: LiveTailProps) {
  return (
    <>
      {replies.map((r) => {
        const text = r.text || r.items;
        const failed = !r.cancelled && r.error ? failedOf(r) : null;
        const next = failed?.code ? NEXT[failed.code] : undefined;
        const thinking = r.note == null && !r.final && !text && !r.failure;
        return (
          <div key={r.key ?? r.line_id} data-live={r.line_id}>
            <TextMessage mine fresh at={r.at} text={r.said} roleName={roleName} {...menu} />
            {r.note != null ? (
              <p className={styles.note}>{r.note}</p>
            ) : r.side ? (
              <SideMessage fresh at={r.at} text={text} streaming={!r.final} roleName={roleName} headUrl={headUrl} lineId={r.line_id} frontTitle={frontTitle} onFront={onFront} onQueue={() => onQueue(r.said)} queueOff={queueOff} {...menu} />
            ) : (
              !thinking && <TextMessage mine={false} fresh at={r.at} text={text} roleName={roleName} headUrl={headUrl} streaming={!r.final} lineId={r.line_id} turnId={r.line_id} {...menu} />
            )}
            {thinking && <Thinking roleName={roleName} headUrl={headUrl} />}
            {r.cancelled && <p className={styles.note}>■ 已取消</p>}
            {failed && (
              <p className={styles.note}>
                ■ {failed.reason}
                {next && (
                  <Btn size="sm" variant="text" onClick={() => navigate(next.to)}>
                    {next.label}
                  </Btn>
                )}
                {r.failure?.retryable && (
                  <Btn size="sm" variant="text" onClick={() => onRetry(r)}>
                    重试
                  </Btn>
                )}
              </p>
            )}
          </div>
        );
      })}
      {incomplete && <p className={styles.note}>实时输出曾中断，回复完成后将显示完整内容</p>}
      {runEnd && (
        <p className={styles.endline}>
          <span className={styles.endText}>{runEnd}</span>
          <i className={styles.endDeco} aria-hidden="true" />
        </p>
      )}
    </>
  );
}
