import { useCallback, useEffect, useRef, useState } from 'react';
import { getBridge, type StreamEvent } from '../../bridge';
import type { Message, Plan } from '../../domain';
import type { SendOptions } from './Composer';
import { planSteps } from './useChatData';

/** A line sent from here, from its send until its turn shows up in `/turns`; until its 202 `line_id` is a local id. */
export interface LiveReply {
  line_id: string;
  /** The local id it showed under before its 202; kept as its React key. */
  key?: string;
  /** The conversation it was sent to (null until a first line has opened one); another conversation does not show it. */
  conversation_id: string | null;
  run_id: string | null;
  generation: number;
  /** What the user sent, with which options, and when. */
  said: string;
  options: SendOptions;
  at: number;
  /** Sent while the foreground run worked: agentd answers it in a read-only side session (server.py say()). */
  side: boolean;
  /** `line` text_delta so far. */
  text: string;
  /** `agent_item` assistant_text deltas, shown until the line brings text. */
  items: string;
  final: boolean;
  error: string | null;
  /** Its run's failed `agent_run` (classify_failure() in harness/runner.py); the line itself carries only `error`. */
  failure?: { code: string | null; public_message: string | null; retryable: boolean };
  provider?: string | null;
  account_label?: string | null;
  cancelled: boolean;
  /** A deterministic command's local confirmation in place of a reply; such an entry is final from the start. */
  note?: string;
}

/** The end of this conversation's latest run (`agent_run` with a terminal phase). */
export interface RunEnd {
  run_id: string;
  phase: string;
  outcome: string | null;
}

export interface FeedHandlers {
  /** A line of this conversation ended: re-read its turns and the list. */
  turns: () => void;
  /** A run, request or delivery changed: re-read the task reads. */
  tasks: () => void;
  /** The feed lost events: re-read everything. */
  reload: () => void;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
/** The feed events this page reads: replies, run items and ends, plans, interactions and deliveries. */
const EVENTS = new Set(['line', 'agent_item', 'agent_run', 'plan', 'agent_interaction', 'delivery', 'background_job', 'turn_accepted']);

type Data = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

type LineUpdate = Pick<LiveReply, 'text' | 'final' | 'error' | 'cancelled' | 'provider' | 'account_label'>;
const EARLY_LINES = 12;

/** `/feed` for one conversation: live replies, live plans, the latest run end, and whether live text has gaps. */
export function useChatFeed(conv: string | null, handlers: FeedHandlers) {
  const [replies, setReplies] = useState<LiveReply[]>([]);
  const [plans, setPlans] = useState<Record<string, Plan>>({});
  const [runEnd, setRunEnd] = useState<RunEnd | null>(null);
  const [incomplete, setIncomplete] = useState(false);
  const [allowedTools, setAllowedTools] = useState<Array<Extract<Message, { kind: 'tool' }>>>([]);
  const convRef = useRef(conv);
  const on = useRef(handlers);
  const live = useRef(replies);
  const early = useRef(new Map<string, LineUpdate>());
  const pendingSends = useRef(new Set<string>());
  useEffect(() => {
    on.current = handlers;
    live.current = replies;
  });

  useEffect(() => {
    convRef.current = conv;
    setPlans({});
    setRunEnd(null);
    setIncomplete(false);
    setAllowedTools([]);
  }, [conv]);

  useEffect(() => {
    const onEvent = (e: StreamEvent) => {
      if (e.event === 'reset' || e.event === 'gap') return lost();
      if (!EVENTS.has(e.event)) return;
      let d: Data;
      try { d = JSON.parse(e.data) as Data; } catch { return lost(); }
      if (d == null || typeof d !== 'object') return lost();
      const mine = d.conversation_id === convRef.current;
      switch (e.event) {
        case 'line': {
          const id = str(d.line_id);
          const delta = str(d.text_delta) ?? '';
          const finish = d.final === true ? { final: true, error: str(d.error), provider: str(d.provider), account_label: str(d.account_label), cancelled: d.cancelled === true } : {};
          if (id) {
            if (pendingSends.current.size > 0) {
              const previous = early.current.get(id) ?? { text: '', final: false, error: null, cancelled: false };
              early.current.set(id, { ...previous, text: previous.text + delta, ...finish });
              if (early.current.size > EARLY_LINES) early.current.delete(early.current.keys().next().value!);
            }
            setReplies((rs) => rs.map((r) => r.line_id === id ? { ...r, text: r.text + delta, ...finish } : r));
          }
          if (d.final === true && (mine || d.conversation_id == null)) on.current.turns();
          return;
        }
        case 'agent_item': {
          const run = str(d.run_id);
          if (d.kind !== 'assistant_text' || d.status !== 'delta' || d.work_kind !== 'foreground' || !run) return;
          setReplies((rs) => rs.map((r) => (r.run_id === run && !r.final ? { ...r, items: r.items + (str(d.text_delta) ?? '') } : r)));
          return;
        }
        case 'agent_run': {
          const phase = str(d.phase);
          const run = str(d.run_id);
          if (phase === 'failed' && run) {
            const failure = { code: str(d.code), public_message: str(d.public_message), retryable: d.retryable === true };
            setReplies((rs) => rs.map((r) => (r.run_id === run ? { ...r, failure } : r)));
          }
          if (!phase || !run || d.work_kind === 'semantic') return;
          if (mine && d.work_kind !== 'background' && TERMINAL.has(phase)) setRunEnd({ run_id: run, phase, outcome: str(d.outcome) });
          if (TERMINAL.has(phase) || phase === 'running' || phase === 'waiting_user') on.current.tasks();
          return;
        }
        case 'plan': {
          const run = str(d.run_id);
          if (!mine || !run || !Array.isArray(d.steps)) return;
          const plan: Plan = { revision: Number(d.revision) || 0, steps: planSteps(d.steps as Array<{ text: string; status: string }>), run_id: run };
          const title = str(d.title);
          const status = str(d.status);
          setPlans((p) => ({ ...p, [run]: { ...plan, ...(title ? { title } : {}), ...(status ? { status } : {}) } }));
          return;
        }
        case 'agent_interaction':
          if (mine && d.state === 'allowed_session' && d.session_allowed === true && typeof d.tool === 'string') {
            setAllowedTools((rows) => [...rows, { kind: 'tool', at: Number(d.at) * 1000,
              label: [str(d.server), d.tool].filter(Boolean).join('/'), ms: 0, summary: '', sessionAllowed: true }]);
          }
          on.current.tasks();
          return;
        case 'delivery':
        case 'background_job':
        case 'turn_accepted':
          on.current.tasks();
          return;
      }
    };
    const lost = () => {
      if (live.current.some((r) => !r.final)) setIncomplete(true);
      setPlans({});
      on.current.reload();
    };
    return getBridge().feed.subscribe(onEvent, lost);
  }, []);

  const add = useCallback((r: Omit<LiveReply, 'text' | 'items' | 'final' | 'error' | 'cancelled'>) => {
    pendingSends.current.add(r.line_id);
    setReplies((rs) => [...rs, { ...r, text: '', items: '', final: r.note != null, error: null, cancelled: false }]);
  }, []);

  /** Puts `r` on the entry added under the local `id`, in place; `null` takes the entry back out. */
  const settle = useCallback((id: string, r: Partial<LiveReply> | null) => {
    if (r == null || r.line_id || r.note != null) pendingSends.current.delete(id);
    const beforeAck = r?.line_id ? early.current.get(r.line_id) : undefined;
    if (r?.line_id) early.current.delete(r.line_id);
    setReplies((rs) => (r ? rs.map((x) => (x.line_id === id ? { ...x, ...r, ...beforeAck, key: id, final: x.final || r.note != null || beforeAck?.final === true } : x)) : rs.filter((x) => x.line_id !== id)));
  }, []);

  return { replies, plans, runEnd, incomplete, allowedTools, add, settle };
}
