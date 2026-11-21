import type { CanonicalTaskId, Message, Question, Task } from '../../domain';

/** Turn end states worth a word at the reply's end (history.py STATES). */
export const TURN_STATE: Readonly<Record<string, string>> = { cancelled: '已取消', interrupted: '已中断', failed: '失败' };

/** Turn sources other than typed text (history.py SOURCES). */
export const TURN_SOURCE: Readonly<Record<string, string>> = { voice: '语音', proactive: '主动', announce: '播报', ritual: '例行', gift: '礼物', tap: '点击' };

const RUN_END: Readonly<Record<string, string>> = { failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const OUTCOME: Readonly<Record<string, string>> = { succeeded: '通过', failed: '未通过', needs_review: '待复核' };

/** 「已完成 · 通过」 style line for a run's end (`agent_run` phase and outcome). */
export function runEndLabel(phase: string, outcome: string | null): string {
  if (phase !== 'completed') return RUN_END[phase] ?? phase;
  const o = outcome ? OUTCOME[outcome] : undefined;
  return o ? `已完成 │ ${o}` : '已完成';
}

/** The conversation stream: its turns as agentd stored them, with the conversation's role tasks and requests placed at their creation times. */
export function chatStream(turns: readonly Message[], tasks: readonly Task[], requests: readonly Question[], allowedTools: readonly Extract<Message, { kind: 'tool' }>[] = []): Message[] {
  const extra = [
    ...allowedTools.map((m) => ({ at: m.at ?? 0, m })),
    ...tasks.map((t) => ({ at: t.created_at, m: { kind: 'task', task_id: t.id as CanonicalTaskId } as Message })),
    ...requests.map((q) => ({ at: q.since, m: { kind: 'question', question_id: q.id, at: q.since } as Message })),
  ].sort((a, b) => a.at - b.at);
  const out: Message[] = [];
  let i = 0;
  for (const m of turns) {
    const at = 'at' in m ? (m.at ?? null) : null;
    for (let x = extra[i]; at != null && x && x.at < at; x = extra[++i]) out.push(x.m);
    out.push(m);
  }
  return [...out, ...extra.slice(i).map((x) => x.m)];
}
