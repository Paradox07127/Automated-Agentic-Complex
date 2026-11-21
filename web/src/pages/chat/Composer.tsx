import { useEffect, useState, type KeyboardEvent } from 'react';
import type { RuntimeInfo } from '../../domain';
import { KernelChain } from '../../features/kernel';
import { Btn, Icon, Menu, type MenuItem } from '../../ui';
import { reasonOf } from './actions';
import styles from './Composer.module.css';
import { pickScope, recentScope, shortName, type ChatScope } from './scope';

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
  alternative: RuntimeInfo | null;
  /** Text of a message that failed to send; kept for 「重新发送」. */
  failed: { text: string; reason: string; options?: SendOptions } | null;
  sending: boolean;
  /** Why 附加窗口 is off (screenshot sharing is off), else null. */
  lookOff?: string | null;
  /** One line from the last send's receipt (scope warning, read-only turn). */
  notice?: string | null;
  onSend: (text: string, options: SendOptions) => void;
  onResend: () => void;
  onDiscardFailed: () => void;
  onContinue: () => void;
  onRestore?: () => void;
  onRecheck: () => void;
  onCopy: (cmd: string) => void;
  /** Only when the shell can run a command in a terminal. */
  onRunInTerminal?: (cmd: string) => void;
  onSwitchKernel: (id: string) => void;
  /** Text put into the input; a new object puts it in again. */
  draft?: { text: string } | null;
}

const NO_MODEL = new Set(['no_llm', 'missing_api_key', 'native_login_required', 'local_runtime_missing', 'credentials_rejected',
  'usage_limit', 'subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable', 'pi_connection_missing']);

/** Input area: kernel-not-ready block with the kernel chain, send failure with the original text kept, two option chips, 资料 and 发送. */
export function Composer(p: ComposerProps) {
  const [text, setText] = useState('');
  const [look, setLook] = useState(false);
  const [noMem, setNoMem] = useState(false);
  const [scope, setScope] = useState<ChatScope | null>(null);
  const [scopeNote, setScopeNote] = useState<string | null>(null);
  const noModel = NO_MODEL.has(p.modelError ?? p.kernel?.reason ?? '');
  useEffect(() => {
    if (p.draft) setText(p.draft.text);
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
  const send = () => {
    if (text.trim() === '' || off) return;
    p.onSend(text.trim(), { look: look && !p.lookOff, no_memory: noMem, ...(scope && !noMem ? { scope_id: scope.id } : {}) });
    setText('');
    setLook(false);
    setNoMem(false);
    setScopeNote(null);
  };
  /** `none` is the line when nothing comes back; a cancelled picker says nothing. */
  const take = async (find: () => Promise<ChatScope | null>, none?: string) => {
    setScopeNote(null);
    try {
      const s = await find();
      if (s) setScope(s);
      else if (none) setScopeNote(none);
    } catch (e) {
      setScopeNote(`资料没有带上：${reasonOf(e)}`);
    }
  };
  const scopeItems: MenuItem[] = [
    { kind: 'item', label: '选文件…', onSelect: () => void take(() => pickScope('file')) },
    { kind: 'item', label: '选文件夹…', onSelect: () => void take(() => pickScope('folder')) },
    { kind: 'item', label: '用最近的资料', onSelect: () => void take(recentScope, '还没有可用的资料') },
  ];
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };
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
          <span className={styles.kernelH}>
            <span className={styles.att} aria-hidden="true">
              ▲
            </span>
            <b>角色内核未就绪</b>
            <span className={styles.cap}>{p.kernel.name} 未就绪，就绪后可发送</span>
            <span className={styles.sp} />
            <Btn size="sm" variant="ghost" icon="refresh" onClick={p.onRecheck}>
              重新检测
            </Btn>
          </span>
          <KernelChain runtime={p.kernel} alternative={p.alternative} surface="inline" onCopy={p.onCopy} onRunInTerminal={p.onRunInTerminal} onSwitch={p.onSwitchKernel} onRecheck={p.onRecheck} />
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
      {scopeNote && <p className={styles.notice}>{scopeNote}</p>}
      <textarea
        className={styles.input}
        rows={2}
        value={text}
        placeholder={off ? '内核就绪后可发送' : `输入消息，⌘↩ 发送给 ${p.roleName}`}
        disabled={off}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        aria-label="消息"
      />
      <div className={styles.foot}>
        <button
          type="button"
          className={styles.chip}
          aria-pressed={look && !p.lookOff}
          data-on={(look && !p.lookOff) || undefined}
          aria-disabled={off || p.lookOff != null || undefined}
          title={p.lookOff ?? '附加当前前台窗口'}
          onClick={() => !off && !p.lookOff && setLook(!look)}
        >
          <Icon name="look" size={14} />
          {look && !p.lookOff ? '已附加窗口' : '附加窗口'}
        </button>
        <button type="button" className={styles.chip} aria-pressed={noMem} data-on={noMem || undefined} disabled={off} title="本轮不写入聊天记录和记忆" onClick={() => setNoMem(!noMem)}>
          <Icon name="privacy" size={14} />
          本轮不记录
        </button>
        {off || noMem ? (
          <button type="button" className={styles.chip} disabled title={noMem ? '临时对话不带资料' : '选文件或文件夹给角色读'}>
            <Icon name="file" size={14} />
            {scope ? shortName(scope.name) : '资料'}
          </button>
        ) : (
          <span className={styles.scope} title={scope?.name ?? '选文件或文件夹给角色读'}>
            <Menu label={scope ? shortName(scope.name) : '资料'} items={scopeItems} />
            {scope && (
              <button type="button" className={styles.chip} aria-label="这次不带资料" title="这次不带资料，授权不撤销" onClick={() => setScope(null)}>
                <Icon name="close" size={14} />
              </button>
            )}
          </span>
        )}
        <span className={styles.sp} />
        {p.sideHint && !off && <span className={`${styles.cap} ${styles.busy}`} title="前台执行中，新消息由只读旁路回答">前台执行中，新消息由只读旁路回答</span>}
        <Btn variant={p.quietSend ? 'secondary' : 'primary'} icon="send" tail="send" kbd="⌘↩" loading={p.sending} disabled={off || text.trim() === ''} disabledReason={off ? '内核未就绪' : '先输入消息'} onClick={send}>
          发送
        </Btn>
      </div>
    </div>
  );
}
