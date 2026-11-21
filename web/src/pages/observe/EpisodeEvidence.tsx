// 从记忆页 EpisodeEvidence 复制：GET /episodes/{id}/evidence 的依据行和运行回执，只在抽屉打开时读。
import { useQuery } from '@tanstack/react-query';
import { get, seg } from '../../bridge/agentd';
import { formatMs } from '../../domain';
import { RawFold } from '../../features/trace';
import { ErrBar, KV, Pill, Sheet, Skel } from '../../ui';
import { errorText } from './data';
import s from './Panels.module.css';

/** GET /episodes/{id}/evidence (server.py `_episode_evidence`). */
interface WireEvidence {
  header: string[];
  lines: Array<{ n: number; tag: string; text: string }>;
  run: {
    backend: string;
    model: string;
    attempt: number;
    duration_ms: number;
    outcome: string;
    reasons: unknown[];
  } | null;
}

const OUTCOME: Readonly<Record<string, string>> = {
  committed: '记忆已写入',
  completed: '生成完成',
  no_new_knowledge: '无新增知识',
  failed: '生成失败',
  rejected: '校验未通过',
  cancelled: '已取消',
};
const BACKEND: Readonly<Record<string, string>> = {
  claude_agent_sdk: 'Claude Agent SDK',
  codex: 'Codex',
  pi: 'Pi',
  acp: 'ACP',
  claude: 'Claude Code',
};
const TAG: Readonly<Record<string, string>> = {
  你: '用户',
  agent: '角色',
  自动: '自动',
  猜测: '推断',
  conversation: '对话',
  external_work_record: '工作记录',
  role_task: '角色任务',
};

const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v);
const textOf = (v: unknown) => (typeof v === 'string' ? v : '');

/** What one source item says: a work record's card text, a role task's result in a sentence. */
function contentText(item: Record<string, unknown>): string | null {
  const c = item.content;
  if (c == null || c === '') return null;
  if (typeof c === 'string') return `内容：${c}`;
  if (!isObj(c)) return null;
  if (item.kind === 'role_task') return `结果：${item.verified === true ? '任务完成' : c.error != null || c.reason != null ? '任务没有完成' : '任务有结果，待复核'}`;
  return textOf(c.text) || null;
}

/** A character-kernel line is the JSON of its source item; show what was said and found, and fold the JSON of an object content. */
function lineOf(text: string): { text: string; raw: boolean } {
  if (!text.startsWith('{')) return { text, raw: false };
  try {
    const item = JSON.parse(text) as Record<string, unknown>;
    const parts = [textOf(item.user) && `用户：${textOf(item.user)}`, textOf(item.assistant) && `回复：${textOf(item.assistant)}`, contentText(item)].filter(Boolean);
    return parts.length > 0 ? { text: parts.join(' │ '), raw: isObj(item.content) } : { text: '这一条没有可显示的内容', raw: true };
  } catch {
    return { text, raw: false };
  }
}

export function EpisodeEvidence({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['observe', 'evidence', id],
    queryFn: () => get<WireEvidence>(`/episodes/${seg(id ?? '')}/evidence`),
    enabled: id != null,
    retry: false,
    // The lines quote what was on screen; nothing is kept after the sheet closes.
    gcTime: 0,
  });
  const d = q.data;
  const run = d?.run;
  const lines = (d?.lines ?? []).map((l) => ({ ...l, shown: lineOf(l.text) }));
  const raw = [...(d?.header ?? []), ...lines.filter((l) => l.shown.raw).map((l) => `${l.n} ${l.text}`)];
  return (
    <Sheet open={id != null} title="片段出处" width={480} onClose={onClose}>
      {q.isError ? (
        <ErrBar message={errorText(q.error)} onRetry={() => void q.refetch()} />
      ) : !d ? (
        <Skel rows={5} />
      ) : (
        <RawFold summary={[`${d.lines.length} 条依据，出处保留 48 小时`]} {...(raw.length > 0 ? { raw: raw.join('\n'), rawLabel: '原始事实单' } : {})}>
          <div className={s.evBody}>
            <KV
              items={
                run
                  ? [
                      {
                        key: '结果',
                        value: OUTCOME[run.outcome] ?? '其他结果',
                      },
                      {
                        key: '内核',
                        value: <span title={run.backend}>{BACKEND[run.backend] ?? '其他内核'}</span>,
                      },
                      { key: '模型', value: run.model, mono: true },
                      {
                        key: '用时',
                        value: <span className="num">{formatMs(run.duration_ms)}</span>,
                      },
                      ...(run.attempt > 1
                        ? [
                            {
                              key: '尝试',
                              value: <span className="num">第 {run.attempt} 次</span>,
                            },
                          ]
                        : []),
                    ]
                  : [{ key: '结果', value: '没有运行回执' }]
              }
            />
            <ol className={s.evLines}>
              {lines.map((l) => (
                <li key={l.n} className={s.evLine}>
                  <span className={`${s.cap} num`}>{l.n}</span>
                  <Pill tone="neutral">{TAG[l.tag] ?? '其他'}</Pill>
                  <span className={s.evText} data-selectable="">
                    {l.shown.text}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </RawFold>
      )}
    </Sheet>
  );
}
