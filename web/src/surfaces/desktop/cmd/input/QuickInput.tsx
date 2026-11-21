import { useEffect, useRef, useState } from 'react';
import { getBridge, type SayReplyTo, type SayRequest, type SayResult, type SaySurface } from '../../../../bridge';
import { failureText } from '../../../../domain/errorText';
import { navRoute } from '../../../../shell/nav';
import { Attached } from './Attached';
import { QuickInputBox, type SayFailure } from './QuickInputBox';
import { dropSay, type Attachment } from './selection';
import styles from './QuickInput.module.css';

/** How long 「你：…」 stays before native is asked to close the panel. */
export const ECHO_MS = 2000;

/** The unsent text, kept in the page while native closes and reopens the panel; only a sent line clears it. */
let draft = '';

export interface QuickInputProps {
  /** Character name. */
  role: string;
  prefill?: string;
  /** The push-to-talk key's label; none hides 按住…说话. */
  talkKey?: string;
  autoFocus: boolean;
  /** 屏幕识读 is on: 附上当前窗口 shows. */
  look: boolean;
  /** Preview preset: the text and error a demo starts with. */
  initial?: { text: string; error: SayFailure };
  /** What it opened with; a scope goes with every line sent from it. */
  attachment?: Attachment | null;
  /** The entry every line from it is sent as. */
  surface: SaySurface;
  /** The line or thought of hers every line from it answers. */
  replyTo?: SayReplyTo;
  /** ✕ on the attachment. */
  onDrop?: () => void;
  /** Esc, ⌘J, or the echo ended: native hides the panel. `sent` is true after the echo. */
  onClose: (sent: boolean) => void;
}

/** 快速输入 through `desktop.say`: a sent line echoes in place for 2 s; a failed one stays with its reason and a fix. */
export function QuickInput({ role, prefill, talkKey, autoFocus, look, initial, attachment, surface, replyTo, onDrop, onClose }: QuickInputProps) {
  const bridge = getBridge();
  const [text, setText] = useState(initial?.text ?? prefill ?? draft);
  const [attach, setAttach] = useState(false);
  const [noMemory, setNoMemory] = useState(false);
  const [error, setError] = useState<SayFailure | null>(initial?.error ?? null);
  const [sending, setSending] = useState(false);
  const [echo, setEcho] = useState<string | null>(null);
  /** The last request sent, which 重新检测 sends again. */
  const last = useRef<SayRequest | null>(null);
  const inFlight = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (echo == null) return;
    const t = setTimeout(() => closeRef.current(true), ECHO_MS);
    return () => clearTimeout(t);
  }, [echo]);

  const typed = (r: SayRequest): SayRequest => dropSay(r, attachment);

  const send = async (sent: SayRequest) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const r = { ...sent, surface, ...(replyTo && { replyTo }) };
    last.current = r;
    setSending(true);
    let res: SayResult;
    try {
      res = await bridge.desktop.say(r);
    } catch (e) {
      const err = e as { code?: string; detail?: string } | null;
      res = { ok: false, reason: 'rejected', detail: failureText({ status: 0, code: err?.code, detail: err?.detail }).text };
    }
    inFlight.current = false;
    setSending(false);
    if (res.ok) {
      draft = '';
      setError(null);
      onDrop?.();
      setEcho(r.text);
    } else setError(res);
  };

  if (echo != null)
    return (
      <p className={styles.echo} role="status" data-region="">
        <span className={styles.you}>你：</span>
        {echo}
      </p>
    );
  return (
    <QuickInputBox
      role={role}
      text={text}
      onText={(t) => {
        draft = t;
        setText(t);
        setError(null);
      }}
      prefix={prefill}
      talkKey={talkKey}
      attachment={attachment && <Attached attachment={attachment} typed={text} sending={sending} onDrop={() => onDrop?.()} onSend={(r) => void send(r)} />}
      blank={
        attachment?.kind === 'window'
          ? '看看这个窗口'
          : attachment?.kind === 'scope' && (attachment.scopeId || attachment.items?.length)
            ? '看看这些'
            : undefined
      }
      attach={attach}
      attachDisabled={attachment?.kind === 'window'}
      noMemory={noMemory}
      onAttach={look ? setAttach : undefined}
      onNoMemory={setNoMemory}
      error={error}
      sending={sending}
      autoFocus={autoFocus}
      onSend={(r) => void send(typed(r))}
      onClose={() => onClose(false)}
      onRestartBackend={() =>
        void bridge.supervisor.restart('agentd').then(
          () => setError(null),
          () => setError({ ok: false, reason: 'agentd' }),
        )
      }
      onRecheck={() => void send(last.current ?? typed({ text: text.trim(), attachWindow: attach, noMemory }))}
      onOpenChat={() => {
        bridge.window.openMain(navRoute({ page: 'chat' }));
        onClose(false);
      }}
    />
  );
}
