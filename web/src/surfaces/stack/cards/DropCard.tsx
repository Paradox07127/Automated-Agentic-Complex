import { useState } from 'react';
import { getBridge, type DropItem, type SayResult } from '../../../bridge';
import { AgentdCallError, call, seg } from '../../../bridge/agentd';
import { formatClock } from '../../../domain';
import { failureText } from '../../../domain/errorText';
import { Btn } from '../../../ui';
import type { Act } from '../actions';
import { CardFrame } from '../CardFrame';
import { HudCard } from '../HudCard';
import { priorityOf, type DesktopStackCard } from '../model';
import body from './NoticeBody.module.css';
import desk from './DesktopNotice.module.css';
import styles from './DropCard.module.css';

/** 提醒's times, as the words agentd's 「提醒我…」 parser reads. */
const WHEN: ReadonlyArray<[string, string]> = [
  ['半小时后', '半小时后'],
  ['1 小时后', '1小时后'],
  ['明天 9 点', '明天上午9点'],
];

const KIND_LABEL = { file: '文件', url: '链接', text: '文字' } as const;

/** agentd's `POST /agent/scopes` reply; `expires_at` is epoch seconds. */
interface Scope {
  scope_id: string;
  expires_at: number;
  /** The dropped files it reads; the unsupported ones are left out. */
  files: unknown[];
  /** The dropped folders it reads. */
  roots: unknown[];
  unsupported: Array<{ path: string; reason: string }>;
}

type Status = { tone: 'ok' | 'err'; text: string };

const label = (i: DropItem) => (i.kind === 'file' ? i.name : i.kind === 'url' ? i.url : i.text);
/** A name to put in a sentence to her; a dropped text can be long. */
const short = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
const counted = (name: string, n: number, unit: string) => short(name) + (n > 1 ? ` 等 ${n} ${unit}` : '');

function sayFailure(r: Extract<SayResult, { ok: false }>): string {
  if (r.reason === 'agentd') return '后台服务没有运行';
  if (r.reason === 'kernel') return r.detail ? `角色内核未就绪 │ ${r.detail}` : '角色内核未就绪';
  return r.detail ?? '后台不接受这条';
}

const callFailure = (e: unknown) =>
  e instanceof AgentdCallError ? failureText({ status: e.status, code: e.code, detail: e.detail ?? null }).text : e instanceof Error ? e.message : String(e);

/** 交给她卡（原生 `addDrop`）：只列出拖给她的路径、链接和文字；用户选了动作才建只读这些文件的范围，范围和 [撤销] 一直留在卡上。 */
export interface DropCardProps {
  card: Extract<DesktopStackCard, { variant: 'drop' }>;
  top: boolean;
  highlight?: boolean;
  act: Act;
}

export function DropCard({ card, top, highlight, act }: DropCardProps) {
  const bridge = getBridge();
  const [scope, setScope] = useState<(Scope & { revoked: boolean }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [picking, setPicking] = useState(false);
  /** agentd answered `no_supported_files`: it reads none of the dropped files. */
  const [none, setNone] = useState(false);
  const files = card.items.filter((i): i is Extract<DropItem, { kind: 'file' }> => i.kind === 'file');
  const words = card.items.filter((i) => i.kind !== 'file');
  const subject = card.items[0] ? counted(label(card.items[0]), card.items.length, '项') : '';

  /** The scope of exactly the dropped files: the one on the card while it still holds, else a new one. */
  const current = async (): Promise<Scope> => {
    if (scope && !scope.revoked && scope.expires_at * 1000 > Date.now()) return scope;
    const made = await call<Scope>('POST', '/agent/scopes', { files: files.map((f) => ({ handle: f.handle })) });
    setScope({ ...made, revoked: false });
    return made;
  };
  const scopeId = async () => (await current()).scope_id;

  /** `done` null clears the line: the card shows the outcome elsewhere. */
  const run = async (lead: string, done: string | null, step: () => Promise<SayResult | void>) => {
    setBusy(true);
    try {
      const r = await step();
      setStatus(r && !r.ok ? { tone: 'err', text: `${lead}：${sayFailure(r)}` } : done === null ? null : { tone: 'ok', text: done });
    } catch (e) {
      const unread = e instanceof AgentdCallError && e.code === 'no_supported_files';
      if (unread) setNone(true);
      setStatus({ tone: 'err', text: unread ? '这些她还读不了' : `${lead}：${callFailure(e)}` });
    }
    setBusy(false);
  };

  const say = (text: string, scope?: string) => bridge.desktop.say({ text, attachWindow: false, noMemory: false, ...(scope ? { scopeId: scope } : {}) });

  const summarize = () => run('没能交给她总结', '已交给她总结', async () => say('总结这些文件', await scopeId()));
  /** 问: 快速输入 opens beside her with the scope, and what is typed there reads these files. */
  const ask = () =>
    run('没能问她', null, async () => {
      const s = await current();
      await bridge.desktop.action('quickInput', JSON.stringify({ scopeId: s.scope_id, files: s.files.length + s.roots.length })).catch(() => {
        throw new Error('快速输入没有打开');
      });
    });
  const queue = () =>
    run('没能建任务', '已建后台任务', async () => {
      const title = `整理 ${counted(files[0]?.name ?? '', files.length, '个文件')}`;
      await call('POST', '/agent/jobs', { title, text: '读这些文件，整理要点', scope_id: await scopeId() });
    });
  const remember = () => run('没能记住', '已让她记住', () => say(`记住 ${words.map(label).join('\n')}`));
  const remind = (when: string) => {
    setPicking(false);
    return run('没能设提醒', '已让她提醒你', () => say(`提醒我${when}看「${subject}」`));
  };
  const revoke = (id: string) =>
    run('没能撤销', null, async () => {
      await call('POST', `/agent/scopes/${seg(id)}/revoke`);
      setScope((s) => s && { ...s, revoked: true });
    });

  return (
    <CardFrame cardId={card.id} highlight={highlight}>
      <HudCard
        title={card.title}
        state="awaiting_input"
        label={`交给她：${subject}`}
        eyebrow="Drop"
        priority={priorityOf(card)}
        top={top}
        onClose={() => act({ type: 'archive', id: card.id })}
        footer={
          picking ? (
            WHEN.map(([shown, spoken]) => (
              <Btn key={shown} variant="secondary" size="sm" disabled={busy} onClick={() => void remind(spoken)}>
                {shown}
              </Btn>
            ))
          ) : (
            <>
              {files.length > 0 && !none && (
                <>
                  <Btn variant="secondary" size="sm" loading={busy} onClick={() => void summarize()}>
                    总结
                  </Btn>
                  <Btn variant="ghost" size="sm" disabled={busy} onClick={() => void ask()}>
                    问
                  </Btn>
                  <Btn variant="ghost" size="sm" disabled={busy} onClick={() => void queue()}>
                    建任务
                  </Btn>
                </>
              )}
              {words.length > 0 && (
                <Btn variant="ghost" size="sm" disabled={busy} onClick={() => void remember()}>
                  记住
                </Btn>
              )}
              <Btn variant="ghost" size="sm" disabled={busy} onClick={() => setPicking(true)}>
                提醒
              </Btn>
            </>
          )
        }
      >
        <ul className={styles.list}>
          {card.items.map((i, n) => (
            <li key={n} title={i.kind === 'file' ? i.path : undefined}>
              <span className={styles.kind}>{KIND_LABEL[i.kind]}</span>
              <span className={styles.name}>{label(i)}</span>
              {i.kind === 'file' && (none || scope?.unsupported.some((u) => u.path === i.path)) && <span className={styles.off}>暂不支持读取</span>}
            </li>
          ))}
        </ul>
        {card.truncated && <p className={body.meta}>拖入的内容太多，有些没收下</p>}
        {scope && (
          <p className={body.meta}>
            {scope.revoked ? (
              '已撤销读取授权'
            ) : (
              <>
                <span className={desk.meta}>{`可读这 ${scope.files.length} 个文件 │ ${formatClock(scope.expires_at * 1000)} 失效`}</span>
                <Btn variant="quiet" size="sm" disabled={busy} onClick={() => void revoke(scope.scope_id)}>
                  撤销
                </Btn>
              </>
            )}
          </p>
        )}
        {status && <p className={status.tone === 'err' ? desk.err : body.meta}>{status.text}</p>}
        {files.length > 0 && <p className={body.meta}>结果存在后台数据目录，重置后台时删除</p>}
      </HudCard>
    </CardFrame>
  );
}
