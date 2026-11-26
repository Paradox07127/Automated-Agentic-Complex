import { replyText } from '../bridge/fake/feed';
import type { WireConversation, WireTurn } from '../domain/wire';
import { atS, CHARACTERS, DAY, WIRE_CONVERSATIONS, WIRE_CONVERSATIONS_BUSY } from './fixtures';
import { C1_TURNS, MEETUP, MEETUP_CONV, MEETUP_TURNS, OTHER_CONVS, OTHER_TURNS, S1, SPARSE_CONV, SPARSE_TURNS } from './fixtures/chatDemo';
import type { MockResponse, MockRoute } from './types';
import { C1, C2, C3, C4, C5, C6, C7, C8, CHARACTER } from './fixtures/ids';

// Chat page endpoints in agentd's shapes (control_panel.py, conversations.py). `?fail=1` selects
// the error demos and `?demo=sparse` the one-conversation list; the page adds them only on the fake bridge.

const DAY_S = DAY / 1000;

const turn = (conversation_id: string, n: number, user_text: string, reply: string, started_at: number, ended_at: number): WireTurn => ({
  id: n,
  event_id: `evt-${n}`,
  turn_id: `tr${n}`,
  source: 'text',
  character_id: CHARACTER,
  persona_revision: '3',
  user_text,
  reply,
  state: 'completed',
  started_at,
  ended_at,
  conversation_id,
});

/** Turns of the history conversations; times stay inside each conversation's day. */
const HISTORY: Record<string, WireTurn[]> = {
  [C2]: [
    turn(C2, 198, 'HostLink 重连要多久？', '从断开到重连成功平均 2.4 s，最长一次 6.1 s。', atS(10, 42), atS(10, 43)),
    turn(C2, 199, '断线前后 CPU 有异常吗？', '没有，断线前后 CPU 都在 12% 上下。', atS(10, 55), atS(10, 56)),
    turn(C2, 200, '把重连日志的级别调到 debug。', '已改为 debug，下次断线会记下每次握手。', atS(11, 5), atS(11, 6)),
    turn(C2, 201, 'HostLink 又断了，帮我看看日志。', '日志里 11:38 心跳连续 3 次超时，之后重连成功。超时阈值是 1.5 s，网络抖动时偏紧。', atS(11, 38), atS(11, 40)),
  ],
  [C3]: [turn(C3, 181, '十月的开销先按类别归一下。', '好的，我先读 10 月账单，按餐饮、交通、订阅和其他四类归类。', atS(9, 10), atS(9, 12))],
  [C4]: [turn(C4, 121, 'Metal 帧率在 120 Hz 下掉到 90 多，帮我看看。', '主要耗时在阴影 pass，降一级阴影分辨率后 p95 回到 7.9 ms。', atS(16, 2) - 2 * DAY_S, atS(16, 5) - 2 * DAY_S)],
  [C5]: [turn(C5, 61, '搬家要准备什么，列个清单。', '按「搬家前一周 / 前一天 / 当天」三段列好了，放在对话里。', atS(20, 38) - 8 * DAY_S, atS(20, 40) - 8 * DAY_S)],
};

const archived = (id: string, title: string, days: number): WireConversation => ({
  id,
  character_id: CHARACTER,
  title,
  pinned: false,
  archived: true,
  revision: 3,
  created_at: atS(10, 0) - days * DAY_S,
  updated_at: atS(11, 0) - days * DAY_S,
  turn_count: 6,
  active: false,
  preview: '',
});

const TURNS: Record<string, WireTurn[]> = { [C1]: C1_TURNS, [S1]: SPARSE_TURNS, [MEETUP]: MEETUP_TURNS, ...HISTORY, ...OTHER_TURNS };

/** conversations.py `preview`: the last turn's reply, else its user text, whitespace collapsed, cut at 60. */
const previewOf = (turns: WireTurn[] | undefined, fallback: string) => {
  const last = turns?.at(-1);
  return last ? (last.reply || last.user_text).replace(/\s+/g, ' ').trim().slice(0, 60) : fallback;
};

/** C1 shows its last four turns of 13, so the replies read as turns 10–13. */
const ROWS: WireConversation[] = [
  ...WIRE_CONVERSATIONS.map((c) => (c.id === C1 ? { ...c, turn_count: 13 } : c)),
  MEETUP_CONV,
  archived(C6, '九月旅行计划', 30),
  archived(C7, '简历修改', 21),
  archived(C8, '读书笔记', 12),
  ...OTHER_CONVS,
].map((c) => ({ ...c, preview: previewOf(TURNS[c.id], c.preview) }));

/** conversations.py `turns` rows: history.py COLUMNS, without the conversation_id a /history row adds. */
const asTurn = ({ conversation_id: _c, ...t }: WireTurn): WireTurn => ({ ...t, raw_reply: t.raw_reply ?? null });

const ok = (status: number, body: unknown): MockResponse => ({ status, body });
const err = (status: number, error: string): MockResponse => ({ status, body: { error } });
const obj = (body: unknown): Record<string, unknown> => (body != null && typeof body === 'object' ? (body as Record<string, unknown>) : {});
const versioned = (body: unknown) => Number.isInteger(obj(body).expected_version);
/** `quote_turn` names a turn of this conversation and which side of it. */
const quotes = (quote: unknown, of: WireTurn[]) => {
  const q = obj(quote);
  return Object.keys(q).length === 2 && (q.part === 'user' || q.part === 'reply') && of.some((t) => t.turn_id === q.turn_id);
};

/** A line agentd took: the fake bridge streams its reply on the feed. */
export interface SaidLine {
  line_id: string;
  conversation_id: string;
  character_id: string;
}

export interface ChatMockHooks {
  /** `server.character`: the character on the desktop. */
  present: () => string;
  /** Starts her reply; the returned stop cancels it and tells whether it cut the reply short. */
  said?: (line: SaidLine) => (() => boolean) | undefined;
}

/** One list's topics with each character's selected one (conversation_settings `active:<character_id>`). */
interface Pool {
  rows: WireConversation[];
  actives: Record<string, string>;
}

const pool = (seed: WireConversation[]): Pool => {
  const rows = seed.map((c) => ({ ...c }));
  return { rows, actives: Object.fromEntries(rows.filter((c) => c.active).map((c) => [c.character_id, c.id])) };
};

/** The latest reply of a conversation, by the run id agentd answered its message with. */
interface Run {
  run_id: string;
  generation: number;
  turn: WireTurn;
  stop: (() => boolean) | undefined;
}

/** The chat routes over their own copy of the rows: writes stay until the bridge that made them goes. */
export function chatRoutes({ present, said }: ChatMockHooks): MockRoute[] {
  const full = pool(ROWS);
  const sparse = pool([SPARSE_CONV]);
  // Only the list read carries `?demo=sparse`; the writes after it act on the list it showed.
  let current = full;
  const turns: Record<string, WireTurn[]> = Object.fromEntries(Object.entries(TURNS).map(([id, t]) => [id, [...t]]));
  const runs: Record<string, Run> = {};
  const find = (id: string | undefined) => {
    for (const p of [full, sparse]) {
      const row = p.rows.find((c) => c.id === id);
      if (row) return { p, row };
    }
    return null;
  };
  const shown = (p: Pool, c: WireConversation): WireConversation => ({ ...c, active: p.actives[c.character_id] === c.id });
  const busyFor = (p: Pool, character: string) => p === full && WIRE_CONVERSATIONS_BUSY && character === present();
  let created = 0;
  let lines = 0;
  /** conversations.py `_create`: a new topic, selected for its owner. */
  const open = (p: Pool, character: string, title: string): WireConversation => {
    const now = atS(14, 32, 10);
    const row: WireConversation = { id: `c9b8a7f6e5d4c3b2a1f0e9d8c7b6a${(0x5f9 + created++).toString(16)}`, character_id: character, title, pinned: false, archived: false, revision: 1, created_at: now, updated_at: now, turn_count: 0, active: true, preview: '' };
    p.rows.unshift(row);
    p.actives[character] = row.id;
    turns[row.id] = [];
    return row;
  };
  return [
    {
      method: 'GET',
      path: '/conversations',
      handler: ({ query }) => {
        const character = query.get('character') ?? present();
        if (!CHARACTERS.some((c) => c.id === character)) return err(404, 'unknown_character');
        if (query.get('fail')) return err(503, 'no_history');
        current = query.get('demo') === 'sparse' ? sparse : full;
        // conversations.py list(): pinned first, then newest.
        const listed = current.rows.filter((c) => c.character_id === character).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at);
        return ok(200, { conversations: listed.map((c) => shown(current, c)), busy: busyFor(current, character), character });
      },
    },
    {
      method: 'GET',
      path: '/conversations/:id/turns',
      handler: ({ params }) => (find(params.id) ? ok(200, { turns: (turns[params.id ?? ''] ?? []).map(asTurn), before: null }) : err(404, 'unknown_conversation')),
    },
    {
      method: 'POST',
      path: '/conversations',
      handler: ({ body }) => {
        const b = obj(body);
        const character = 'character_id' in b ? b.character_id : present();
        if (typeof character !== 'string' || !CHARACTERS.some((c) => c.id === character)) return err(404, 'unknown_character');
        if (busyFor(current, character)) return err(409, 'busy');
        return ok(201, open(current, character, typeof b.title === 'string' ? b.title : '新对话'));
      },
    },
    {
      method: 'PUT',
      path: '/conversations/:id',
      handler: ({ params, body }) => {
        const hit = find(params.id);
        if (!hit) return err(404, 'unknown_conversation');
        const { p, row } = hit;
        const b = obj(body);
        if (busyFor(p, row.character_id) && p.actives[row.character_id] === row.id && b.archived) return err(409, 'busy');
        if (!versioned(body) || Object.keys(b).length < 2) return err(400, 'invalid_conversation_update');
        if (b.expected_version !== row.revision) return err(409, 'version_conflict');
        const patch = Object.fromEntries((['title', 'pinned', 'archived'] as const).filter((k) => k in b).map((k) => [k, b[k]]));
        Object.assign(row, patch, { revision: row.revision + 1 });
        if (b.archived && p.actives[row.character_id] === row.id) open(p, row.character_id, '新对话');
        return ok(200, shown(p, row));
      },
    },
    {
      method: 'DELETE',
      path: '/conversations/:id',
      handler: ({ params, body }) => {
        const hit = find(params.id);
        if (!hit) return err(404, 'unknown_conversation');
        const { p, row } = hit;
        if (busyFor(p, row.character_id)) return err(409, 'busy');
        if (!versioned(body)) return err(400, 'invalid_conversation_update');
        if (obj(body).expected_version !== row.revision) return err(409, 'version_conflict');
        p.rows.splice(p.rows.indexOf(row), 1);
        delete turns[row.id];
        delete runs[row.id];
        if (p.actives[row.character_id] === row.id) open(p, row.character_id, '新对话');
        return ok(200, { deleted: true });
      },
    },
    {
      method: 'POST',
      path: '/conversations/:id/activate',
      handler: ({ params, body }) => {
        const hit = find(params.id);
        if (!hit) return err(404, 'unknown_conversation');
        const { p, row } = hit;
        if (busyFor(p, row.character_id)) return err(409, 'busy');
        if (!versioned(body)) return err(400, 'invalid_conversation_update');
        if (obj(body).expected_version !== row.revision) return err(409, 'version_conflict');
        if (row.archived) return err(409, 'archived');
        p.actives[row.character_id] = row.id;
        row.revision += 1;
        return ok(200, shown(p, row));
      },
    },
    {
      method: 'POST',
      path: '/conversations/:id/messages',
      handler: ({ params, query, body }) => {
        const hit = find(params.id);
        if (!hit) return err(404, 'unknown_conversation');
        const { p, row } = hit;
        if (query.get('fail')) return err(503, 'no_llm');
        const b = obj(body);
        const text = b.text;
        if (typeof text !== 'string' || text.trim() === '' || text.length > 8000 || Object.keys(b).some((k) => !['text', 'look', 'no_memory', 'scope_id', 'quote_turn'].includes(k))) return err(400, 'invalid_text');
        for (const k of ['look', 'no_memory']) if (k in b && typeof b[k] !== 'boolean') return err(400, `invalid_${k}`);
        if ('scope_id' in b && (typeof b.scope_id !== 'string' || b.scope_id.length < 1 || b.scope_id.length > 128 || b.no_memory === true)) return err(400, 'invalid_scope_id');
        if ('quote_turn' in b && !quotes(b.quote_turn, turns[row.id] ?? [])) return err(400, 'invalid_quote_turn');
        if (row.archived) return err(409, 'archived');
        if (row.character_id !== present()) return ok(409, { error: 'character_not_present', character_id: row.character_id });
        if (p.actives[row.character_id] !== row.id) return err(409, 'conversation_not_active');
        const n = lines++;
        const line_id = (0x7a1e5c0b9d24 + n).toString(16);
        const started = atS(14, 32, 10) + 60 * n;
        const turn: WireTurn = { id: 1000 + n, event_id: `evt-mock-${n}`, turn_id: `tr-mock-${n}`, source: 'text', character_id: row.character_id, persona_revision: '3', user_text: text, reply: replyText(row.character_id), state: 'completed', started_at: started, ended_at: started + 4 };
        const own = (turns[row.id] ??= []);
        own.push(turn);
        Object.assign(row, { turn_count: row.turn_count + 1, updated_at: started + 4, preview: previewOf(own, row.preview) });
        runs[row.id] = { run_id: line_id, generation: 43, turn, stop: said?.({ line_id, conversation_id: row.id, character_id: row.character_id }) };
        return ok(202, { line_id, generation: 43, run_id: line_id, runtime: 'codex', ...(b.no_memory === true ? { runtime_reason: 'temporary_read_only' } : {}) });
      },
    },
    {
      method: 'POST',
      path: '/conversations/:id/cancel',
      handler: ({ params, body }) => {
        const b = obj(body);
        if (Object.keys(b).length !== 2 || typeof b.run_id !== 'string' || !Number.isInteger(b.generation)) return err(400, 'invalid_payload');
        const hit = find(params.id);
        if (!hit) return err(404, 'unknown_conversation');
        const run = runs[hit.row.id];
        // control_panel.py: a run other than the conversation's latest one is not cancelled.
        if (!run || run.run_id !== b.run_id || run.generation !== b.generation) return ok(409, { error: 'run_changed', run_id: run?.run_id ?? null, generation: run?.generation ?? null });
        if (run.stop?.()) {
          Object.assign(run.turn, { state: 'cancelled', reply: '' });
          hit.row.preview = previewOf(turns[hit.row.id], hit.row.preview);
        }
        return ok(202, { run_id: b.run_id, cancellation_requested: true });
      },
    },
    { method: 'POST', path: '/chat/prewarm', handler: () => ok(200, { ready: true }) },
  ];
}

export const routes: MockRoute[] = chatRoutes({ present: () => CHARACTER });
