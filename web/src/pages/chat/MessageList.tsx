import type { ActiveRun, Message, Question } from '../../domain';
import { Btn } from '../../ui';
import type { TasksView } from '../tasks/model';
import { QuestionCard } from './QuestionCard';
import { SideMessage } from './SideMessage';
import { TaskCard } from './TaskCard';
import { TextMessage, type TurnTagInfo } from './TextMessage';
import { ToolRow } from './ToolRow';
import type { TiMem } from './turnTrace';
import type { OnDeliveryReceipt } from '../../features/delivery';
import styles from './Chat.module.css';

const EXAMPLES = ['你能帮我做些什么？', '帮我回顾一下今天做了什么', '记住：我喜欢简短的回答'];

export interface MessageListProps {
  messages: Message[];
  view: TasksView | null;
  /** The foreground run with its plan (live or saved); its inline task shows the steps from it. */
  frontRun?: ActiveRun | null;
  roleName: string;
  /** Requests of this conversation as listed, also handled ones (kind, job, preview). */
  requests?: Question[];
  /** Active character id and the names of all; a reply by another character is signed with its name. */
  roleId?: string | null;
  names?: Record<string, string>;
  now: number;
  answered: Record<string, string>;
  /** Questions cancelled here, by id. */
  cancelled: Record<string, boolean>;
  stopped: Record<string, number>;
  /** Foreground task of this conversation. */
  frontTitle: string | null;
  /** Per reply turn_id: its tag, the facts it used and the facts it added. */
  turnOf: (turnId: string | undefined) => TurnTagInfo | null;
  memsOf: (turnId: string | undefined) => { mems: TiMem[]; learned: TiMem[] };
  /** turn_id open in 轮次详情, and whether the task tab is open. */
  selTurn: string | null;
  openTaskId?: string | null;
  onOpenDrawer: (taskId?: string) => void;
  onAnswer: (questionId: string, answers: Record<string, string[]>) => void;
  onCancelQuestion: (questionId: string) => void;
  onQueueSide: (text: string) => void;
  onTurn: (turnId: string) => void;
  onReceipt?: OnDeliveryReceipt;
  /** An empty conversation offers example questions; a click puts one in the composer. Absent offers none. */
  onExample?: (text: string) => void;
}

/** The conversation stream; every entry kind of `Message` maps to one component. */
export function MessageList(p: MessageListProps) {
  const { messages, view, frontRun = null, roleName, requests = [], roleId, names = {}, now } = p;
  const lastReply = messages.reduce((acc, m, i) => (m.kind === 'ai' || m.kind === 'side' ? i : acc), -1);
  const toolMax = Math.max(1, ...messages.map((m) => (m.kind === 'tool' ? m.ms : 0)));
  // Who speaks each entry; tool rows and task cards do not break a speaker's run.
  const speaker = (m: Message) => (m.kind === 'me' ? 'me' : m.kind === 'ai' ? (m.character_id ?? roleId ?? '') : m.kind === 'side' || m.kind === 'question' ? (roleId ?? '') : null);
  let last: string | null = null;
  const first = messages.map((m) => {
    const s = speaker(m);
    if (s == null) return false;
    const f = s !== last;
    last = s;
    return f;
  });
  if (messages.length === 0 && p.onExample) {
    const onExample = p.onExample;
    return (
      <div className={styles.examples}>
        {EXAMPLES.map((t) => (
          <Btn key={t} size="sm" variant="secondary" onClick={() => onExample(t)}>
            {t}
          </Btn>
        ))}
      </div>
    );
  }
  return (
    <>
      {messages.map((m, i) => {
        switch (m.kind) {
          case 'me':
            return <TextMessage key={i} mine at={m.at} text={m.text} roleName={roleName} first={first[i]} />;
          case 'ai': {
            const signer = m.character_id && roleId && m.character_id !== roleId ? (names[m.character_id] ?? '角色') : roleName;
            const tag = p.turnOf(m.turn_id);
            const { mems, learned } = p.memsOf(m.turn_id);
            return (
              <TextMessage
                key={i}
                mine={false}
                at={m.at}
                text={m.text}
                roleName={signer}
                roleId={m.character_id ?? roleId}
                first={first[i]}
                latest={i === lastReply}
                state={m.state}
                source={m.source}
                turn={tag && { ...tag, ttft: tag.ttft ?? m.ttft_ms ?? null }}
                selected={m.turn_id != null && m.turn_id === p.selTurn}
                mems={mems}
                learned={learned}
                {...(m.turn_id ? { onTurn: () => p.onTurn(m.turn_id!) } : {})}
              />
            );
          }
          case 'side':
            return (
              <SideMessage
                key={i}
                at={m.at}
                text={m.text}
                streaming={m.streaming && i === lastReply}
                roleName={roleName}
                roleId={roleId}
                first={first[i]}
                frontTitle={p.frontTitle}
                onFront={p.onOpenDrawer}
                onQueue={() => p.onQueueSide(m.text)}
              />
            );
          case 'tool':
            return <ToolRow key={i} label={m.label} ms={m.ms} summary={m.summary} code={m.code} sessionAllowed={m.sessionAllowed} maxMs={toolMax} />;
          case 'task': {
            const t = view?.tasks.find((x) => x.id === m.task_id);
            if (!t || !view) return null;
            const listed = view.activeRuns[t.id] ?? null;
            const delivery = [...view.deliveries.filter((d) => d.task_id === t.id)].sort((a, b) => b.version - a.version)[0] ?? null;
            return (
              <TaskCard
                key={i}
                task={t}
                effective={view.effective[t.id] ?? 'running'}
                activeRun={listed && frontRun?.run_id === listed.run_id ? frontRun : listed}
                pending={view.pending.filter((x) => x.task_id === t.id)}
                stoppedAt={p.stopped[t.id] ?? null}
                delivery={delivery}
                now={now}
                selected={p.openTaskId === t.id}
                onOpenTask={() => p.onOpenDrawer(t.id)}
                onReceipt={p.onReceipt}
              />
            );
          }
          case 'question': {
            const q = view?.pending.find((x) => x.id === m.question_id);
            return (
              <QuestionCard
                key={i}
                at={m.at}
                question={q && q.kind === 'question' ? q : null}
                request={requests.find((r) => r.id === m.question_id)}
                roleName={roleName}
                roleId={roleId}
                first={first[i]}
                now={now}
                answered={p.answered[m.question_id] ?? null}
                cancelled={p.cancelled[m.question_id] ?? false}
                onAnswer={(a) => p.onAnswer(m.question_id, a)}
                onCancel={() => p.onCancelQuestion(m.question_id)}
              />
            );
          }
        }
      })}
    </>
  );
}
