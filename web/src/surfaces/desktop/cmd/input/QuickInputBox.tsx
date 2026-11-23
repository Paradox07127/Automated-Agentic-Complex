import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { SayRequest, SayResult } from '../../../../bridge';
import { Btn, ErrBar, Icon, Kbd, TextArea } from '../../../../ui';
import { PowerMark, PowerState, type PowerStateProps } from '../../../../ui/game';
import styles from './QuickInputBox.module.css';

export type SayFailure = Extract<SayResult, { ok: false }>;

/**
 * 快速输入: 420 wide, 1–4 rows; ⏎ sends, ⇧⏎ breaks the line, esc closes, ⌘J opens
 * 对话. ⏎ while an input method is composing only picks the candidate. A failed send keeps the text and turns the line red.
 * Borrowed parts in the page's appearance: interaction-menu head and structure line, toast field,
 * selected-row capsule chips; the error bar stays dark in both.
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
        <button type="button" className={styles.esc} aria-label="关闭快速输入" title="Esc" onClick={p.onClose}>
          <Icon name="close" size={16} />
        </button>
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
          <button type="button" className={styles.chip} title="已关闭：设置 › 观察里关着「屏幕识读」，点按前往设置打开" onClick={p.onLookOff}>
            <PowerMark state="off" compact />
            附上当前窗口
          </button>
        )}
        {p.onAttach && (
          <button type="button" className={styles.chip} aria-pressed={p.attach} disabled={p.attachDisabled} onClick={() => p.onAttach?.(!p.attach)}>
            {p.attach && <Icon name="check" size={14} />}附上当前窗口
          </button>
        )}
        <button type="button" className={styles.chip} aria-pressed={p.noMemory} onClick={() => p.onNoMemory(!p.noMemory)}>
          {p.noMemory && <Icon name="check" size={14} />}这一轮不记
        </button>
      </div>
      <div className={styles.footer}>
        <button type="button" className={styles.aux} onClick={p.onOpenChat}>
          <Kbd>⌘J</Kbd>对话
        </button>
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
