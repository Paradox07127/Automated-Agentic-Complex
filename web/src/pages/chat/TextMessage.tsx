import { useEffect, useState } from 'react';
import { formatClock, formatMs } from '../../domain';
import { useDevMode } from '../../shell/devMode';
import { navigate } from '../../shell/nav';
import { artSrc } from '../../ui';
import { MessageText } from './MessageText';
import { fitsBubble } from './snsTemplate';
import { TURN_SOURCE, TURN_STATE } from './stream';
import type { TiMem, TurnRes } from './turnTrace';
import styles from './Messages.module.css';

/** What the reply's turn tag reads: its ordinal and the `/trace/turns` row paired by turn_id. */
export interface TurnTagInfo {
  no: number;
  res: TurnRes;
  ms: number;
  ttft?: number | null;
  provider?: string | null;
  account_label?: string | null;
}

export interface TextMessageProps {
  mine: boolean;
  at: number;
  text: string;
  roleName: string;
  /** A live or temporary reply's request identity, before a history turn tag exists. */
  model?: Pick<TurnTagInfo, 'provider' | 'account_label'>;
  latest?: boolean;
  /** Turn end state; cancelled, interrupted and failed show at the reply's end. */
  state?: string;
  /** Turn source; anything but typed text shows beside the time. */
  source?: string;
  /** Live reply still coming in. */
  streaming?: boolean;
  /** The reply's turn; no tag without one. */
  turn?: TurnTagInfo | null;
  /** Its turn is open in 轮次详情. */
  selected?: boolean;
  mems?: TiMem[];
  learned?: TiMem[];
  onTurn?: () => void;
  /** Speaker's character id; with `first` her round head goes before the name. */
  roleId?: string | null | undefined;
  /** First of consecutive messages by this speaker. */
  first?: boolean;
}

/** Chat row head: her round icon in a ring over a halftone, beside the first bubble of a run; a plain img, as message rows are told apart by `[data-kind]`. */
export function WhoAva({ roleId }: { roleId: string | null | undefined }) {
  const src = artSrc(roleId, 'round');
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className={`${styles.ava} sns-avatar-ring sns-avatar-halftone`} aria-hidden="true">
      {src && failed !== src ? <img src={src} width={38} height={38} alt="" onError={() => setFailed(src)} /> : <i className={`${styles.generic} sns-avatar-generic`} />}
    </span>
  );
}

/** The generic single head the SNS gives senders without art (user lines). */
export function GenericAva() {
  return (
    <span className={`${styles.ava} sns-avatar-ring sns-avatar-halftone`} aria-hidden="true">
      <i className={`${styles.generic} sns-avatar-generic`} />
    </span>
  );
}

export function TurnTag({ turn, selected, onTurn }: { turn: TurnTagInfo; selected?: boolean; onTurn?: () => void }) {
  const bad = turn.res === '失败';
  const tip = `第 ${turn.no} 轮 │ ${turn.res}\n整轮 ${formatMs(turn.ms)}${turn.ttft != null ? ` │ 首字 ${formatMs(turn.ttft)}` : ''}`;
  return (
    <button type="button" className={styles.tt} data-on={selected || undefined} aria-pressed={!!selected} aria-label={`第 ${turn.no} 轮，${turn.res}，打开轮次详情`} title={tip} onClick={onTurn}>
      第 <span className="num">{turn.no}</span> 轮 │ <span className="num">{formatMs(turn.ms)}</span>
      {bad && (
        <b className={styles.ttX} aria-hidden="true">
          ✕
        </b>
      )}
    </button>
  );
}

/** 「新增记忆 n 条」「引用记忆 n 条」; the caller puts them in the reply's tag row. */
export function MemTags({ mems = [], learned = [] }: { mems?: TiMem[]; learned?: TiMem[] }) {
  return (
    <>
      {learned.length > 0 && (
        <button type="button" className={styles.mt} data-new="" onClick={() => navigate({ page: 'memory', view: 'about', sel: learned[0]?.id ?? '' })}>
          + 新增记忆 <span className="num">{learned.length}</span> 条
        </button>
      )}
      {mems.length > 0 && (
        <button type="button" className={styles.mt} onClick={() => navigate({ page: 'memory', view: 'about', sel: mems[0]?.id ?? '' })}>
          引用记忆 <span className="num">{mems.length}</span> 条
        </button>
      )}
    </>
  );
}

const ACCOUNT_LABEL: Readonly<Record<string, string>> = {
  codex_login: 'Codex 登录', claude_login: 'Claude 登录', deepseek_api: 'DeepSeek API',
  anthropic_api: 'Anthropic API', anthropic_other: 'Anthropic API', openai_api: 'OpenAI API',
  compatible_api: '兼容 API', chatgpt_subscription: 'ChatGPT 登录',
  deepseek: 'DeepSeek API', anthropic: 'Anthropic API', openai: 'OpenAI API', compatible: '兼容 API', chatgpt: 'ChatGPT 登录',
  codex_existing_login: 'Codex 登录', codex_product_login: 'Codex 登录', codex_api_key: 'OpenAI API',
  claude_agent_sdk_existing_login: 'Claude 登录', claude_agent_sdk_product_login: 'Claude 登录', claude_agent_sdk_api_key: 'Anthropic API',
  claude_existing_login: 'Claude 登录',
};

export function ProviderLine({ provider, account_label }: Pick<TurnTagInfo, 'provider' | 'account_label'>) {
  return provider ? <span className={styles.provider}>{ACCOUNT_LABEL[account_label ?? ''] ?? ACCOUNT_LABEL[provider] ?? provider}</span> : null;
}

/** A reply crosses into the content card once; it does not swap back while it streams. */
export function useCardShape(text: string): boolean {
  const fits = fitsBubble(text);
  const [crossed, setCrossed] = useState(!fits);
  useEffect(() => {
    if (!fits && !crossed) setCrossed(true);
  }, [fits, crossed]);
  return crossed || !fits;
}

/** User line (self bubble) or role reply (bubble, or the long-reply card); under a reply, the field line: the turn tag 「第 n 轮 │ 4.2 s」 that opens 轮次详情, then its memory tags. */
export function TextMessage({ mine, at, text, roleName, latest, state, source, streaming, model, turn, selected, mems, learned, onTurn, roleId, first = true }: TextMessageProps) {
  const provider = model?.provider ?? turn?.provider;
  const account = model?.account_label ?? turn?.account_label;
  const via = source ? TURN_SOURCE[source] : undefined;
  const ended = state ? TURN_STATE[state] : undefined;
  const ava = !mine && first;
  const tag = onTurn != null;
  const detailedTag = useDevMode() && turn;
  const tags = !mine && (tag || (mems?.length ?? 0) > 0 || (learned?.length ?? 0) > 0);
  const card = useCardShape(text) && !mine;
  return (
    <div className={styles.msg} data-kind={mine ? 'me' : 'ai'} data-shape={card ? 'card' : 'bubble'} data-first={first || undefined} data-latest={latest || undefined} data-sel={selected || undefined}>
      <div className={styles.who} data-ava={ava || undefined} data-cont={!first || undefined}>
        {ava && <WhoAva roleId={roleId} />}
        {mine && first && <GenericAva />}
        <span className={styles.name}>{mine ? '用户' : roleName}</span>
        <span className={styles.tm}>
          {formatClock(at)}
          {via ? ` │ ${via}` : ''}
        </span>
        {!mine && <ProviderLine provider={provider} account_label={account} />}
      </div>
      <div className={card ? styles.card : `${styles.bubble} ${mine ? 'sns-bubble-self' : 'sns-bubble-other'}`}>
        <div className={styles.body}>
          {(text || streaming) && <MessageText text={text} streaming={streaming} />}
          {ended && <p className={styles.ended}>■ {ended}</p>}
        </div>
      </div>
      {tags && (
        <span className={styles.mtags}>
          {tag && (detailedTag ? <TurnTag turn={detailedTag} selected={selected} onTurn={onTurn} /> : (
            <button type="button" className={styles.tt} aria-pressed={!!selected} onClick={onTurn}>运行详情</button>
          ))}
          <MemTags mems={mems} learned={learned} />
        </span>
      )}
    </div>
  );
}
