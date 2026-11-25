import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { SayRequest, SayResult } from '../../../../bridge';
import { Btn, ErrBar, FilterChips, IconBtn, Kbd, TextArea, type FilterChip } from '../../../../ui';
import { PowerMark, PowerState, type PowerStateProps } from '../../../../ui/game';
import styles from './QuickInputBox.module.css';

export type SayFailure = Extract<SayResult, { ok: false }>;

/**
 * 快速输入: 420 wide, 1–4 rows; ⏎ sends, ⇧⏎ breaks the line, esc closes, ⌘J opens
 * 对话. ⏎ while an input method is composing only picks the candidate. A failed send keeps the text and turns the line red.
 * Borrowed parts in the page's appearance: interaction-menu head and structure line, toast field;
 * the error bar stays dark in both.
 */
export interface QuickInputBoxProps {
  /** Character name for the head. */
  role: string;
  text: string;
  onText: (t: string) => void;
  /** An instruction prefix: send once the user has entered a request. */
  prefix?: string;
  /** The push-to-talk key's label, shown as 按住…说话; none shows nothing. */
  talkKey?: string;
  /** What 快速输入 opened with, under the head. */
  attachment?: ReactNode;
  /** What ⏎ sends while nothing is typed; none sends nothing then. */
  blank?: string;
  attach: boolean;
  /** 附上当前窗口 can't be turned on, as when a window is attached already. */
  attachDisabled?: boolean;
  noMemory: boolean;
  /** Absent, 附上当前窗口 does not show. */
  onAttach?: (on: boolean) => void;
  /** 屏幕识读 is off: 附上当前窗口 shows as 已关闭 and a click opens its switch. */
  onLookOff?: () => void;
  /** What it cannot reach before anything is sent, as 未接入 over the input, which stays usable. */
  unlinked?: Pick<PowerStateProps, 'title' | 'reason' | 'action'> | undefined;
  onNoMemory: (on: boolean) => void;
  error: SayFailure | null;
  sending: boolean;
  autoFocus?: boolean;
  onSend: (r: SayRequest) => void;
  onClose: () => void;
  onRestartBackend: () => void;
  onRecheck: () => void;
  onOpenChat: () => void;
}

/** A keydown this soon after `compositionend` is the one that committed the candidate (WebKit fires it after the end). */
const COMMIT_SLOP_MS = 50;

export function QuickInputBox(p: QuickInputBoxProps) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const endedAt = useRef(-Infinity);
  const rows = Math.min(4, Math.max(1, p.text.split('\n').length));
  const body = p.prefix && p.text.startsWith(p.prefix) ? p.text.slice(p.prefix.length) : p.text;
  const said = body.trim() !== '' ? p.text.trim() : p.blank;
  const send = () => {
    if (said && !p.sending) p.onSend({ text: said, attachWindow: p.attach, noMemory: p.noMemory });
  };

  useEffect(() => {
    const el = ta.current;
    if (!p.autoFocus || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [p.autoFocus, p.prefix]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current || e.timeStamp - endedAt.current < COMMIT_SLOP_MS) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      p.onClose();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      p.onOpenChat();
    }
  };

  // 附上当前窗口 is left out while it cannot be turned on (a window is attached already).
  const opts: FilterChip[] = [...(p.onAttach && !p.attachDisabled ? [{ value: 'attach', label: '附上当前窗口' }] : []), { value: 'nomem', label: '这一轮不记' }];
  const picked = [...(p.attach ? ['attach'] : []), ...(p.noMemory ? ['nomem'] : [])];
  const pick = (v: string[]) => {
    if (v.includes('attach') !== p.attach) p.onAttach?.(!p.attach);
    if (v.includes('nomem') !== p.noMemory) p.onNoMemory(!p.noMemory);
  };

  const err = p.error;
  const field = (
    <div className={styles.body}>
      <TextArea
        hud
        textareaRef={ta}
        rows={rows}
        value={p.text}
        readOnly={p.sending}
        placeholder="帮我查这个报错"
        label={`对 ${p.role} 说的话`}
        onChange={p.onText}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          endedAt.current = e.timeStamp;
        }}
        onKeyDown={onKey}
      />
    </div>
  );
  return (
    <div className={styles.box} role="dialog" aria-label="快速输入" data-err={err ? err.reason : undefined} data-region="">
      <span className={styles.sline} aria-hidden="true">
        <span className={styles.cap}>esc</span>
        <span className={styles.cap}>⏎</span>
      </span>
      <div className={styles.head}>
        <span className={styles.deco} aria-hidden="true" />
        <span className={styles.title}>{`对 ${p.role} 说`}</span>
        <span className={styles.esc}>
          <IconBtn icon="close" size="sm" label="关闭快速输入" onClick={p.onClose} />
        </span>
      </div>
      {p.attachment}
      {p.unlinked ? (
        <PowerState hud state="unlinked" mode="block" {...p.unlinked}>
          {field}
        </PowerState>
      ) : (
        field
      )}
      {err && (
        <div className={styles.err} data-theme="dark">
          {err.reason === 'agentd' && (
            <ErrBar message="后台服务没有运行" detail="原文已保留"
              actions={<Btn variant="ghost" size="sm" onClick={p.onRestartBackend}>重启后台服务</Btn>} />
          )}
          {err.reason === 'kernel' && (
            <ErrBar tone="warning" message="角色内核未就绪" detail={err.detail ?? '原文已保留'}
              actions={<Btn variant="ghost" size="sm" icon="refresh" onClick={p.onRecheck}>重新检测</Btn>} />
          )}
          {err.reason === 'rejected' && <ErrBar message={`没有发出去：${err.detail ?? '后台不接受这条'}`} detail="原文已保留" />}
        </div>
      )}
      <div className={styles.opts}>
        {p.onLookOff && (
          <span title="已关闭：设置 › 感知里关着「屏幕识读」，点按前往设置打开">
            <Btn variant="text" size="sm" onClick={p.onLookOff}>
              <PowerMark state="off" compact />
              附上当前窗口
            </Btn>
          </span>
        )}
        <FilterChips label="这一轮的选项" multiple options={opts} value={picked} onChange={pick} />
      </div>
      <div className={styles.footer}>
        <Btn variant="text" size="sm" kbd="⌘J" onClick={p.onOpenChat}>
          对话
        </Btn>
        {p.talkKey && (
          <span className={styles.talk}>
            按住<Kbd>{p.talkKey}</Kbd>说话
          </span>
        )}
        <Btn variant="primary" icon="send" kbd="⏎" disabled={!said} disabledReason="输入消息后发送" loading={p.sending} onClick={send}>
          发送消息
        </Btn>
      </div>
    </div>
  );
}
