import { useEffect, useState, type KeyboardEvent } from 'react';
import { getBridge, type PickedHandle } from '../../bridge';
import { post } from '../../bridge/agentd';
import type { RuntimeInfo } from '../../domain';
import { Btn, Icon, Menu, type MenuItem } from '../../ui';
import type { WireScope } from '../settings/wire';
import { reasonOf } from './actions';
import { AttachTray, type TrayItem } from './AttachTray';
import styles from './Composer.module.css';

/** Per-message options agentd takes beside the text (control_panel.py messages). */
export interface SendOptions {
  /** Attach the front window. */
  look: boolean;
  /** Keep this turn out of the history and memory. */
  no_memory: boolean;
  /** The 资料 scope this turn may read; never with no_memory. */
  scope_id?: string;
}

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
  /** Selected kernel when it is not ready (banner), else null. */
  kernel: RuntimeInfo | null;
  /** Unused (the kernel is chosen in 设置); optional while Page.tsx still passes it. */
  alternative?: RuntimeInfo | null;
  /** Text of a message that failed to send; kept for 「重新发送」. */
  failed: { text: string; reason: string; options?: SendOptions } | null;
  sending: boolean;
  /** Why 看一眼屏幕 is off (screenshot sharing is off), else null. */
  lookOff?: string | null;
  /** One line from the last send's receipt (scope warning, read-only turn). */
  notice?: string | null;
  onSend: (text: string, options: SendOptions) => void;
  onResend: () => void;
  onDiscardFailed: () => void;
  onContinue: () => void;
  onRestore?: () => void;
  onRecheck: () => void;
  /** Unused (the kernel is chosen in 设置); optional while Page.tsx still passes it. */
  onCopy?: (cmd: string) => void;
  /** Unused (the kernel is chosen in 设置); optional while Page.tsx still passes it. */
  onRunInTerminal?: (cmd: string) => void;
  /** Unused (the kernel is chosen in 设置); optional while Page.tsx still passes it. */
  onSwitchKernel?: (id: string) => void;
  /** Text put into the input; a new object puts it in again. */
  draft?: { text: string } | null;
  /** The topic the input writes to; each keeps its own draft. Null: one draft for all. */
  topicId?: string | null;
  /** A line the user quotes; it goes out as `> ` lines before the text. */
  quote?: string | null;
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

/** Input area: kernel / model notices, send failure with the original text kept, quote, tray, then ＋, the input and 发送. */
export function Composer(p: ComposerProps) {
  const key = p.topicId ?? null;
  const [shown, setShown] = useState(key);
  const [d, setD] = useState<Draft>(() => (key != null && drafts.get(key)) || EMPTY);
  if (shown !== key) {
    setShown(key);
    setD((key != null && drafts.get(key)) || EMPTY);
  }
  const [attaching, setAttaching] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const noModel = NO_MODEL.has(p.modelError ?? p.kernel?.reason ?? '');
  const edit = (next: Partial<Draft>) => setD((cur) => ({ ...cur, ...next }));
  useEffect(() => {
    if (key != null) drafts.set(key, d);
  }, [key, d]);
  useEffect(() => {
    if (p.draft) edit({ text: p.draft.text });
  }, [p.draft]);
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
  const off = p.kernel != null;
  const look = d.look && !p.lookOff;
  const said = d.text.trim();
  const send = async () => {
    if (said === '' || off || attaching) return;
    let scope: { scope_id?: string } = {};
    if (d.files.length > 0) {
      setAttaching(true);
      try {
        scope = { scope_id: (await post<WireScope>('/agent/scopes', { files: d.files })).scope_id };
      } catch (e) {
        // A picked handle is spent once tried: the tray empties and the text stays.
        setNote(`附件没有带上：${reasonOf(e)}`);
        edit({ files: [] });
        return;
      } finally {
        setAttaching(false);
      }
    }
    const quoted = p.quote ? `${p.quote.split('\n').map((l) => `> ${l}`).join('\n')}\n\n${said}` : said;
    p.onSend(quoted, { look, no_memory: d.noMem, ...scope });
    setD(EMPTY);
    setNote(null);
    p.onClearQuote?.();
  };
  const addFile = async () => {
    const h = await getBridge().files.pickFile({ purpose: 'scope_file' });
    if (h) setD((cur) => ({ ...cur, files: [...cur.files, h] }));
  };
  const plus: MenuItem[] = [
    { kind: 'item', label: '添加文件或图片', disabled: off || d.noMem, ...(!off && d.noMem ? { reason: '这句不记时不带文件' } : {}), onSelect: () => void addFile() },
    { kind: 'item', label: '让她看一眼屏幕', checked: look, disabled: off || p.lookOff != null, ...(p.lookOff ? { reason: p.lookOff } : {}), onSelect: () => edit({ look: !d.look }) },
    { kind: 'item', label: '这句不记', checked: d.noMem, disabled: off || d.files.length > 0, ...(!off && d.files.length > 0 ? { reason: '带着文件时不能不记' } : {}), onSelect: () => edit({ noMem: !d.noMem }) },
  ];
  const tray: TrayItem[] = [
    ...d.files.map((f, i) => ({
      key: f.handle,
      name: f.displayName,
      icon: IMAGE.test(f.displayName) ? ('g-image' as const) : ('g-file' as const),
      removeLabel: `移除 ${f.displayName}`,
      onRemove: () => edit({ files: d.files.filter((_, j) => j !== i) }),
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
  const inactive = off || said === '';
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
          <span className={styles.cap}>{p.kernel.name} 未就绪，就绪后可发送</span>
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
      {p.sideHint && !off && <p className={`${styles.cap} ${styles.busy}`} title="前台执行中，新消息由只读旁路回答">前台执行中，新消息由只读旁路回答</p>}
      {p.quote && (
        <div className={styles.quote}>
          <Icon name="g-quote" size={14} />
          <span className={styles.quoteText}>{p.quote}</span>
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
            placeholder={off ? '内核就绪后可发送' : `对${p.roleName}说…`}
            disabled={off}
            onChange={(e) => edit({ text: e.target.value })}
            onKeyDown={onKey}
            aria-label="消息"
          />
        </label>
        <button
          type="button"
          className={styles.send}
          data-quiet={p.quietSend || undefined}
          aria-disabled={inactive || undefined}
          aria-busy={p.sending || attaching || undefined}
          title={off ? '内核未就绪' : said === '' ? '先输入消息' : undefined}
          onClick={() => void send()}
        >
          <Icon name="g-send" size={16} />
          <span>发送</span>
        </button>
      </div>
    </div>
  );
}
