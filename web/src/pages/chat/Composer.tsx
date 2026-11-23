import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { getBridge, type PickedHandle } from '../../bridge';
import type { DroppedHandle } from '../../bridge/adopt';
import { post } from '../../bridge/agentd';
import type { RuntimeInfo } from '../../domain';
import { usePlugins } from '../../shell/plugins';
import { Btn, Icon, Menu, type MenuItem } from '../../ui';
import { AttachTray, type TrayItem } from './AttachTray';
import { reasonOf } from './reasons';
import styles from './Composer.module.css';

/** Per-message options agentd takes beside the text (control_panel.py messages). */
export interface SendOptions {
  /** Attach the front window. */
  look: boolean;
  /** Keep this turn out of the history and memory. */
  no_memory: boolean;
  /** The 资料 scope this turn may read; never with no_memory. */
  scope_id?: string;
  /** Picker handles not yet made into a scope; the page makes it once the user has agreed to the send. */
  files?: PickedHandle[];
  /** The turn of this conversation the line answers; agentd routes it to the full kernel. */
  quote_turn?: { turn_id: string; part: 'user' | 'reply' };
}

/** A line the user quotes: its text for the banner, its turn and which half of it for agentd. */
export interface Quote {
  text: string;
  turn_id: string;
  part: 'user' | 'reply';
}

/** What `onSend` settled: `sent` the line left the input (agentd took it, or the failure card holds it now); `kept` nothing left it; `spent` the file handles were tried and are gone, the text stays. */
export type SendResult = 'sent' | 'kept' | 'spent';

export interface ComposerProps {
  roleName: string;
  /** Stable error code from the latest turn or send refusal. */
  modelError?: string | null;
  /** History conversations cannot send; they offer 「继续此对话」. */
  history: boolean;
  /** Archived: it can be restored, not continued. */
  archived?: boolean;
  /** agentd is busy; a history conversation cannot be continued yet. */
  busy: boolean;
  /** The foreground run works: a new line is answered by the read-only side session. */
  sideHint?: boolean;
  /** The task column shows its decision, the screen's one yellow button: 发送 steps down to secondary. */
  quietSend?: boolean;
  /** Selected kernel when it is not ready (banner only: agentd picks the quick reply or the full kernel itself). */
  kernel: RuntimeInfo | null;
  /** Text of a message that failed to send; kept for 「重新发送」. */
  failed: { text: string; reason: string; options?: SendOptions } | null;
  sending: boolean;
  /** Why 看一眼屏幕 is off (screenshot sharing is off), else null. */
  lookOff?: string | null;
  /** One line from the last send's receipt (scope warning, read-only turn). */
  notice?: string | null;
  onSend: (text: string, options: SendOptions) => Promise<SendResult>;
  onResend: () => void;
  onDiscardFailed: () => void;
  onContinue: () => void;
  onRestore?: () => void;
  onRecheck: () => void;
  /** Text for the input of `topic`; used once, then `onDraftUsed`. */
  draft?: { text: string; topic: string | null } | null;
  onDraftUsed?: () => void;
  /** Files dropped on the dialog for `topic`; used once, then `onDroppedUsed`. */
  dropped?: { files: File[]; topic: string | null } | null;
  onDroppedUsed?: () => void;
  /** The topic the input writes to; each keeps its own draft. Null: one draft for all. */
  topicId?: string | null;
  quote?: Quote | null;
  onClearQuote?: () => void;
}

/** What is typed and attached for one topic. `files` are picker handles, good only in the page that picked them. */
interface Draft {
  text: string;
  files: PickedHandle[];
  look: boolean;
  noMem: boolean;
}

const EMPTY: Draft = { text: '', files: [], look: false, noMem: false };

/** Unsent drafts by topic id, for the life of the page. */
const drafts = new Map<string, Draft>();

const NO_MODEL = new Set(['no_llm', 'missing_api_key', 'native_login_required', 'local_runtime_missing', 'credentials_rejected',
  'usage_limit', 'subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable', 'pi_connection_missing']);

/** The image types among the picker's scope_file types (app/electron SCOPE_FILE_TYPES). */
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** A typing pause this long warms the quick session before 发送. */
const PREWARM_PAUSE_MS = 600;

/** What one line may carry: agentd's text limit (invalid_text), its scope's file count and its image size. */
const MAX_TEXT = 8000;
const MAX_FILES = 16;
const MAX_IMAGE = 5 * 1024 * 1024;

const NO_AGENT = '个人代理没开，不能带文件';

/** The draft after its line went: the text only if it was not edited since, and not the files the line took. */
const without = (cur: Draft, sent: Draft): Draft => ({ ...EMPTY, text: cur.text === sent.text ? '' : cur.text, files: cur.files.filter((f) => !sent.files.some((s) => s.handle === f.handle)) });

/** Input area: kernel / model notices, send failure with the original text kept, quote, tray, then ＋, the input and 发送. */
export function Composer(p: ComposerProps) {
  const key = p.topicId ?? null;
  const [shown, setShown] = useState(key);
  const [d, setD] = useState<Draft>(() => (key != null && drafts.get(key)) || EMPTY);
  if (shown !== key) {
    setShown(key);
    setD((key != null && drafts.get(key)) || EMPTY);
  }
  const [note, setNote] = useState<string | null>(null);
  const agent = usePlugins().personal_agent;
  const noModel = NO_MODEL.has(p.modelError ?? p.kernel?.reason ?? '');
  // The topic and draft on screen now, for work that finishes later.
  const now = useRef({ key, d });
  now.current = { key, d: shown === key ? d : (key != null && drafts.get(key)) || EMPTY };
  const inflight = useRef(false);
  /** Changes the draft of topic `k`, on screen or not; with the composer gone it stays in `drafts`. */
  const update = (k: string | null, change: (cur: Draft) => Draft) => {
    const next = change(k === now.current.key ? now.current.d : (k != null && drafts.get(k)) || EMPTY);
    if (k != null) drafts.set(k, next);
    if (k === now.current.key) {
      now.current.d = next;
      setD(next);
    }
  };
  const tell = (k: string | null, text: string | null) => k === now.current.key && setNote(text);
  const edit = (next: Partial<Draft>) => update(key, (cur) => ({ ...cur, ...next }));
  useEffect(() => {
    if (key != null) drafts.set(key, d);
  }, [key, d]);
  useEffect(() => {
    if (p.history || d.text.trim() === '') return;
    // A failed warm-up changes nothing: the send that follows reports the same error.
    const t = setTimeout(() => void post('/chat/prewarm', {}).catch(() => undefined), PREWARM_PAUSE_MS);
    return () => clearTimeout(t);
  }, [d.text]);
  useEffect(() => {
    if (!p.draft || p.draft.topic !== key) return;
    edit({ text: p.draft.text });
    p.onDraftUsed?.();
  }, [p.draft]);
  useEffect(() => {
    // `adopt` is declared below the history view's early return, which never takes a drop.
    if (!p.dropped || p.history || p.dropped.topic !== key) return;
    void adopt(p.dropped.files, false);
    p.onDroppedUsed?.();
  }, [p.dropped]);
  if (p.history) {
    return (
      <div className={styles.root}>
        <div className={styles.hist}>
          <span>{p.archived ? '已归档对话' : '历史对话'}</span>
          <span className={styles.sp} />
          {p.archived ? (
            <Btn size="sm" variant="secondary" onClick={p.onRestore}>
              恢复对话
            </Btn>
          ) : (
            <Btn size="sm" variant="secondary" disabled={p.busy} disabledReason="角色执行结束后可切换" onClick={p.onContinue}>
              继续此对话
            </Btn>
          )}
          {!p.archived && p.busy && <span className={styles.cap}>角色执行结束后可切换</span>}
        </div>
      </div>
    );
  }
  const look = d.look && !p.lookOff;
  const said = d.text.trim();
  const send = async () => {
    if (said === '' || p.sending || inflight.current) return;
    if ([...said].length > MAX_TEXT) return setNote(`超过 ${MAX_TEXT} 字，删减后再发`);
    const from = d;
    const k = key;
    inflight.current = true;
    try {
      const result = await p.onSend(said, {
        look,
        no_memory: from.noMem,
        ...(from.files.length > 0 && !from.noMem ? { files: from.files } : {}),
        ...(p.quote ? { quote_turn: { turn_id: p.quote.turn_id, part: p.quote.part } } : {}),
      });
      if (result === 'kept') return;
      update(k, (cur) => (result === 'sent' ? without(cur, from) : { ...cur, files: cur.files.filter((f) => !from.files.some((s) => s.handle === f.handle)) }));
      if (result === 'sent' && k === now.current.key) {
        setNote(null);
        p.onClearQuote?.();
      }
    } finally {
      inflight.current = false;
    }
  };
  /** Files picked, dropped or pasted join the draft of `k`, unless 这句不记 turned on or the tray filled meanwhile. */
  const take = (k: string | null, got: PickedHandle[], text: string | null) =>
    update(k, (cur) => {
      tell(k, cur.noMem ? '这句不记时不带文件' : text);
      return cur.noMem ? cur : { ...cur, files: [...cur.files, ...got].slice(0, MAX_FILES) };
    });
  const addFile = async () => {
    const k = key;
    try {
      const h = await getBridge().files.pickFile({ purpose: 'scope_file' });
      if (h) take(k, [h], null);
    } catch (e) {
      tell(k, `文件没带上：${reasonOf(e)}`);
    }
  };
  /** Pasted images go as bytes (they have no path), every other file through the shell's drop handles. */
  const adopt = async (files: File[], pasted: boolean) => {
    const k = key;
    if (!agent) return setNote(NO_AGENT);
    if (now.current.d.noMem) return setNote('这句不记时不带文件');
    const f = getBridge().files;
    const asked = files.slice(0, Math.max(MAX_FILES - now.current.d.files.length, 0));
    const images = pasted ? asked.filter((x) => x.type.startsWith('image/')) : [];
    const fit = images.filter((x) => x.size <= MAX_IMAGE);
    const rest = asked.filter((x) => !images.includes(x));
    const got: DroppedHandle[] = [];
    let why: string | null = null;
    try {
      if (fit.length > 0 && f.adoptPasted) got.push(...(await f.adoptPasted(await Promise.all(fit.map(async (x) => ({ type: x.type, data: await x.arrayBuffer() }))))));
      if (rest.length > 0 && f.adoptDropped) got.push(...(await f.adoptDropped(rest)));
    } catch (e) {
      why = reasonOf(e);
    }
    const left = files.length - got.length;
    const reason = why ?? (files.length > asked.length ? `最多带 ${MAX_FILES} 个` : images.length > fit.length ? '图片超过 5 MiB' : null);
    take(k, got, left > 0 ? `${left} 个文件没带上${reason ? `：${reason}` : ''}` : null);
  };
  const plus: MenuItem[] = [
    { kind: 'item', label: '添加文件或图片', disabled: !agent || d.noMem || d.files.length >= MAX_FILES, ...(!agent ? { reason: NO_AGENT } : d.noMem ? { reason: '这句不记时不带文件' } : d.files.length >= MAX_FILES ? { reason: `最多带 ${MAX_FILES} 个文件` } : {}), onSelect: () => void addFile() },
    { kind: 'item', label: '让她看一眼屏幕', checked: look, disabled: p.lookOff != null, ...(p.lookOff ? { reason: p.lookOff } : {}), onSelect: () => edit({ look: !d.look }) },
    { kind: 'item', label: '这句不记', checked: d.noMem, disabled: d.files.length > 0, ...(d.files.length > 0 ? { reason: '带着文件时不能不记' } : {}), onSelect: () => edit({ noMem: !d.noMem }) },
  ];
  const tray: TrayItem[] = [
    ...d.files.map((f, i) => ({
      key: f.handle,
      name: f.displayName,
      icon: IMAGE.test(f.displayName) ? ('g-image' as const) : ('g-file' as const),
      removeLabel: `移除 ${f.displayName}`,
      onRemove: () => {
        edit({ files: d.files.filter((_, j) => j !== i) });
        void getBridge().files.release?.(f.handle).catch(() => undefined);
      },
    })),
    ...(look ? [{ key: 'look', name: '看一眼屏幕', icon: 'g-window' as const, flag: true, removeLabel: '不看屏幕', onRemove: () => edit({ look: false }) }] : []),
    ...(d.noMem ? [{ key: 'nomem', name: '这句不记', icon: 'g-nomem' as const, flag: true, removeLabel: '取消这句不记', onRemove: () => edit({ noMem: false }) }] : []),
  ];
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const inactive = said === '' || p.sending;
  return (
    <div className={styles.root}>
      {noModel && (
        <div className={styles.kernel} role="alert">
          没有可用的模型：登录 Claude Code 或 Codex，或在 <a href="#/settings?group=model">设置 › pi 账号与凭据</a> 填一个 API key
          <Btn size="sm" variant="ghost" icon="refresh" onClick={p.onRecheck}>
            重新检测
          </Btn>
        </div>
      )}
      {p.kernel && !noModel && (
        <div className={styles.kernel} role="alert">
          <span className={styles.flagMark} aria-hidden="true">
            ▲
          </span>
          <b>角色内核未就绪</b>
          <span className={styles.cap}>{p.kernel.name} 未就绪</span>
          <a href="#/settings?group=kernel">设置 › 角色内核</a>
          <span className={styles.sp} />
          <Btn size="sm" variant="ghost" icon="refresh" onClick={p.onRecheck}>
            重新检测
          </Btn>
        </div>
      )}
      {p.failed && (
        <div className={styles.failed} role="alert">
          <span className={styles.failedText}>{p.failed.text}</span>
          <span className={styles.err}>■ 发送失败：{p.failed.reason} │ 原文已保留</span>
          <Btn size="sm" variant="secondary" icon="refresh" tail="refresh" loading={p.sending} onClick={p.onResend}>
            重新发送
          </Btn>
          <Btn size="sm" variant="text" onClick={p.onDiscardFailed}>
            放弃
          </Btn>
        </div>
      )}
      {p.notice && <p className={styles.notice}>{p.notice}</p>}
      {note && <p className={styles.notice}>{note}</p>}
      {p.sideHint && <p className={`${styles.cap} ${styles.busy}`} title="前台执行中，新消息由只读旁路回答">前台执行中，新消息由只读旁路回答</p>}
      {p.quote && (
        <div className={styles.quote}>
          <Icon name="g-quote" size={14} />
          <span className={styles.quoteText}>{p.quote.text}</span>
          <button type="button" className={styles.x} aria-label="不引用" onClick={p.onClearQuote}>
            <Icon name="g-close" size={12} />
          </button>
        </div>
      )}
      <AttachTray items={tray} />
      <div className={styles.cbar}>
        <span className={styles.plus}>
          <Menu label="附加" icon="g-plus" items={plus} />
        </span>
        <label className={styles.inp}>
          <textarea
            rows={1}
            value={d.text}
            placeholder={`对${p.roleName}说…`}
            onChange={(e) => edit({ text: e.target.value })}
            onKeyDown={onKey}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length === 0 || d.noMem) return;
              // A clipboard with text too keeps its text paste.
              if (e.clipboardData.getData('text/plain') === '') e.preventDefault();
              void adopt(files, true);
            }}
            aria-label="消息"
          />
        </label>
        <Btn variant={p.quietSend ? 'secondary' : 'primary'} tail="g-send" disabled={inactive} {...(said === '' ? { disabledReason: '先输入消息' } : {})} loading={p.sending} onClick={() => void send()}>
          发送
        </Btn>
      </div>
    </div>
  );
}
