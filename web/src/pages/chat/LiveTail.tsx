import { useRef } from 'react';
import { gameClips } from '../../design/gameClips.generated';
import { codeText } from '../../domain/errorText';
import { navigate, type NavTarget } from '../../shell/nav';
import { Btn, useGameClip } from '../../ui';
import { SideMessage } from './SideMessage';
import { TextMessage, WhoAva } from './TextMessage';
import type { LiveReply } from './useChatFeed';
import styles from './Messages.module.css';

export interface LiveTailProps {
  /** Lines sent from here whose turn is not in `/turns` yet. */
  replies: LiveReply[];
  roleName: string;
  /** Her character id: the round head beside her live replies. */
  roleId?: string | null;
  frontTitle: string | null;
  /** The feed lost events while a reply was coming in. */
  incomplete: boolean;
  /** 「已完成 · 通过」 for this conversation's latest run end, if one came by. */
  runEnd: string | null;
  onFront: () => void;
  onQueue: (text: string) => void;
  /** Sends a failed line's text again as a new line. */
  onRetry: (reply: LiveReply) => void;
}

/** The one next step a failed reply offers for its code. */
const NEXT: Readonly<Record<string, { label: string; to: NavTarget }>> = {
  auth_expired: { label: '去登录', to: { page: 'settings', group: 'kernel', item: 'kcur' } },
  native_login_required: { label: '去登录', to: { page: 'settings', group: 'kernel', item: 'kcur' } },
  quota_exhausted: { label: '查看用量', to: { page: 'diag', item: 'usage' } },
};

/** Why a reply failed: the sentence for its run's or its line's code, else agentd's public_message. */
function failedOf(r: LiveReply): { reason: string; code: string | null } {
  const code = [r.failure?.code, r.error].find((c) => codeText(c)) ?? null;
  return { reason: codeText(code) ?? r.failure?.public_message ?? '没有回复', code };
}

/** Typing bubble: three squares on the dark bubble (sns_contentloading_newin, then the squares' colour loop); the words stay for screen readers. */
function Thinking({ roleName, roleId }: { roleName: string; roleId: string | null | undefined }) {
  const plate = useRef<HTMLParagraphElement>(null);
  useGameClip(gameClips.snsLoadingIn, plate, { autoplay: true });
  return (
    <div className={styles.msg} data-first="">
      <div className={styles.who}>
        <WhoAva roleId={roleId} />
        <span className={styles.name}>{roleName}</span>
      </div>
      <p ref={plate} className={`${styles.loading} sns-bubble-other`} data-g="plate">
        <i aria-hidden="true" data-g="dot1" />
        <i aria-hidden="true" data-g="dot2" />
        <i aria-hidden="true" data-g="dot3" />
        <span className={styles.sr}>在想</span>
      </p>
    </div>
  );
}

/** The end of the stream: each line sent here with its live reply, then the run end (end line) and a gap note (system band). */
export function LiveTail({ replies, roleName, roleId, frontTitle, incomplete, runEnd, onFront, onQueue, onRetry }: LiveTailProps) {
  return (
    <>
      {replies.map((r) => {
        const text = r.text || r.items;
        const failed = !r.cancelled && r.error ? failedOf(r) : null;
        const next = failed?.code ? NEXT[failed.code] : undefined;
        const thinking = r.note == null && !r.final && !text && !r.failure;
        return (
          <div key={r.key ?? r.line_id} data-live={r.line_id}>
            <TextMessage mine at={r.at} text={r.said} roleName={roleName} />
            {r.note != null ? (
              <p className={styles.note}>{r.note}</p>
            ) : r.side ? (
              <SideMessage at={r.at} text={text} streaming={!r.final} roleName={roleName} roleId={roleId} model={{ provider: r.provider ?? null, account_label: r.account_label ?? null }} frontTitle={frontTitle} onFront={onFront} onQueue={() => onQueue(r.said)} />
            ) : (
              !thinking && <TextMessage mine={false} at={r.at} text={text} roleName={roleName} roleId={roleId} streaming={!r.final} model={{ provider: r.provider ?? null, account_label: r.account_label ?? null }} />
            )}
            {thinking && <Thinking roleName={roleName} roleId={roleId} />}
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
      {incomplete && <p className={styles.note}>实时输出有中断，回复结束后显示完整内容</p>}
      {runEnd && (
        <p className={styles.endline}>
          <span className={styles.endText}>{runEnd}</span>
          <i className={`${styles.endDeco} sns-endline-deco`} aria-hidden="true" />
        </p>
      )}
    </>
  );
}
