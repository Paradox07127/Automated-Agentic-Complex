import { useEffect, useRef, useState } from 'react';
import { getBridge, type SayReplyTo, type SayRequest, type SayResult, type SaySurface } from '../../../../bridge';
import { get } from '../../../../bridge/agentd';
import type { WireRuntimePublic } from '../../../../domain';
import { codeText, failureText } from '../../../../domain/errorText';
import { navRoute, type NavTarget } from '../../../../shell/nav';
import { usePresence } from '../../hooks/usePresence';
import { fakeDemo, readPresence } from '../../tags/presence';
import { Attached } from './Attached';
import { QuickInputBox, type SayFailure } from './QuickInputBox';
import { dropSay, type Attachment } from './selection';
import styles from './QuickInput.module.css';

/** How long 「你：…」 stays before native is asked to close the panel. */
export const ECHO_MS = 2000;

/** The unsent text, kept in the page while native closes and reopens the panel; only a sent line clears it. */
let draft = '';

/** Why no model can answer (`GET /character/runtime` not ready), read once at open; null while one can or nothing was read. */
function useNoModel(): string | null {
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const demo = fakeDemo();
    get<WireRuntimePublic>(`/character/runtime${demo ? `?demo=${demo}` : ''}`).then(
      (r) => {
        if (live && !r.ready && r.error && !r.error.endsWith('_pending')) setWhy(codeText(r.error) ?? '登录 Claude Code 或 Codex，或在设置里给 pi 填一个 API key');
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return why;
}

export interface QuickInputProps {
  /** Character name. */
  role: string;
  prefill?: string;
  /** The push-to-talk key's label; none hides 按住…说话. */
  talkKey?: string;
  autoFocus: boolean;
  /** 屏幕识读 is on: 附上当前窗口 works; off, it shows as 已关闭 and opens its switch. */
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

/** 快速输入 through `desktop.say`: a sent line echoes in place for 2 s; a failed one stays with its reason and a fix. Without
 *  agentd or a model it opens as 未接入, before anything is sent. */
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
  const offline = readPresence(usePresence()).offline;
  const noModel = useNoModel();

  useEffect(() => {
    if (echo == null) return;
    const t = setTimeout(() => closeRef.current(true), ECHO_MS);
    return () => clearTimeout(t);
  }, [echo]);

  // A removed attachment or a changed toggle makes the last request stale: 重新检测 then builds one from the box.
  useEffect(() => {
    last.current = null;
  }, [attachment, attach, noMemory]);

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

  const restartBackend = () =>
    void bridge.supervisor.restart('agentd').then(
      () => setError(null),
      () => setError({ ok: false, reason: 'agentd' }),
    );
  const settings = (target: NavTarget) => {
    bridge.window.openMain(navRoute(target));
    onClose(false);
  };
  const unlinked = offline
    ? { title: '后台没有响应', reason: '这句发不出去，写好的话会留着', action: { label: '重启后台', onClick: restartBackend } }
    : noModel != null
      ? { title: '没有可用的模型', reason: noModel, action: { label: '前往设置连接', onClick: () => settings({ page: 'settings', group: 'model', item: 'svc' }) } }
      : undefined;

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
      onLookOff={look ? undefined : () => settings({ page: 'settings', group: 'privacy', item: 'plugins.screen_reading' })}
      unlinked={unlinked}
      onNoMemory={setNoMemory}
      error={error}
      sending={sending}
      autoFocus={autoFocus}
      onSend={(r) => void send(typed(r))}
      onClose={() => onClose(false)}
      onRestartBackend={restartBackend}
      onRecheck={() => void send(last.current ?? typed({ text: text.trim(), attachWindow: attach, noMemory }))}
      onOpenChat={() => {
        bridge.window.openMain(navRoute({ page: 'chat' }));
        onClose(false);
      }}
    />
  );
}
