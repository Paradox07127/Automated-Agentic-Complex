import type { WireConversation, WireTurn } from '../domain/wire';
import { atS, CHARACTERS, DAY, WIRE_CONVERSATIONS, WIRE_CONVERSATIONS_BUSY } from './fixtures';
import { C1_TURNS, MEETUP, MEETUP_CONV, MEETUP_TURNS, OTHER_CONVS, OTHER_TURNS, S1, SPARSE_CONV, SPARSE_TURNS } from './fixtures/chatDemo';
import type { MockResponse, MockRoute } from './types';
import { C1, C2, C3, C4, C5, C6, C7, C8, CHARACTER } from './fixtures/ids';

// Chat page endpoints in agentd's shapes (control_panel.py, conversations.py, contract.md of chat v2). `?fail=1` selects
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
const previewOf = (id: string, fallback: string) => {
  const last = TURNS[id]?.at(-1);
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
].map((c) => ({ ...c, preview: previewOf(c.id, c.preview) }));

/** conversations.py `turns` rows: history.py COLUMNS, without the conversation_id a /history row adds. */
const asTurn = ({ conversation_id: _c, ...t }: WireTurn): WireTurn => ({ ...t, raw_reply: t.raw_reply ?? null });

const ok = (status: number, body: unknown): MockResponse => ({ status, body });
const err = (status: number, error: string): MockResponse => ({ status, body: { error } });
const obj = (body: unknown): Record<string, unknown> => (body != null && typeof body === 'object' ? (body as Record<string, unknown>) : {});
const versioned = (body: unknown) => Number.isInteger(obj(body).expected_version);

/** A line agentd took: the fake bridge streams its reply on the feed. */
export interface SaidLine {
  line_id: string;
  conversation_id: string;
  character_id: string;
}

export interface ChatMockHooks {
  /** `server.character`: the character on the desktop. */
  present: () => string;
  said?: (line: SaidLine) => void;
}

/** The chat routes over their own copy of the rows: writes stay until the bridge that made them goes. */
export function chatRoutes({ present, said }: ChatMockHooks): MockRoute[] {
  const rows = ROWS.map((c) => ({ ...c }));
  // conversation_settings `active:<character_id>`.
  const actives: Record<string, string> = Object.fromEntries(rows.filter((c) => c.active).map((c) => [c.character_id, c.id]));
  const all = () => [...rows, SPARSE_CONV];
  const shown = (c: WireConversation): WireConversation => ({ ...c, active: actives[c.character_id] === c.id });
  const busyFor = (character: string) => WIRE_CONVERSATIONS_BUSY && character === present();
  let created = 0;
  let lines = 0;
  return [
    {
      method: 'GET',
      path: '/conversations',
      handler: ({ query }) => {
        const character = query.get('character') ?? present();
        if (!CHARACTERS.some((c) => c.id === character)) return err(404, 'unknown_character');
        if (query.get('fail')) return err(503, 'no_history');
        if (query.get('demo') === 'sparse') return ok(200, { conversations: [SPARSE_CONV], busy: false, character });
        // conversations.py list(): pinned first, then newest.
        const listed = rows.filter((c) => c.character_id === character).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at);
        return ok(200, { conversations: listed.map(shown), busy: busyFor(character), character });
      },
    },
    {
      method: 'GET',
      path: '/conversations/:id/turns',
      handler: ({ params }) => (all().some((c) => c.id === params.id) ? ok(200, { turns: (TURNS[params.id ?? ''] ?? []).map(asTurn), before: null }) : err(404, 'unknown_conversation')),
    },
    {
      method: 'POST',
      path: '/conversations',
      handler: ({ body }) => {
        const b = obj(body);
        const character = typeof b.character_id === 'string' ? b.character_id : present();
        if (busyFor(character)) return err(409, 'busy');
        const title = typeof b.title === 'string' ? b.title : '新对话';
        const now = atS(14, 32, 10);
        const row: WireConversation = { id: `c9b8a7f6e5d4c3b2a1f0e9d8c7b6a${(0x5f9 + created++).toString(16)}`, character_id: character, title, pinned: false, archived: false, revision: 0, created_at: now, updated_at: now, turn_count: 0, active: true, preview: '' };
        rows.unshift(row);
        actives[character] = row.id;
        return ok(201, row);
      },
    },
    {
      method: 'PUT',
      path: '/conversations/:id',
      handler: ({ params, body }) => {
        const row = rows.find((c) => c.id === params.id);
        if (!row) return err(404, 'unknown_conversation');
        const b = obj(body);
        if (!versioned(body) || Object.keys(b).length < 2) return err(400, 'invalid_conversation_update');
        const patch = Object.fromEntries((['title', 'pinned', 'archived'] as const).filter((k) => k in b).map((k) => [k, b[k]]));
        Object.assign(row, patch, { revision: Number(b.expected_version) + 1 });
        return ok(200, shown(row));
      },
    },
    {
      method: 'DELETE',
      path: '/conversations/:id',
      handler: ({ params, body }) => {
        const at = rows.findIndex((c) => c.id === params.id);
        const row = rows[at];
        if (!row) return err(404, 'unknown_conversation');
        if (!versioned(body)) return err(400, 'invalid_conversation_update');
        if (busyFor(row.character_id)) return err(409, 'busy');
        rows.splice(at, 1);
        if (actives[row.character_id] === row.id) delete actives[row.character_id];
        return ok(200, { deleted: true });
      },
    },
    {
      method: 'POST',
      path: '/conversations/:id/activate',
      handler: ({ params, body }) => {
        const row = rows.find((c) => c.id === params.id);
        if (!row) return err(404, 'unknown_conversation');
        if (!versioned(body)) return err(400, 'invalid_conversation_update');
        if (row.archived) return err(409, 'archived');
        if (busyFor(row.character_id)) return err(409, 'busy');
        actives[row.character_id] = row.id;
        row.revision = Number(obj(body).expected_version) + 1;
        return ok(200, shown(row));
      },
    },
    {
      method: 'POST',
      path: '/conversations/:id/messages',
      handler: ({ params, query, body }) => {
        const row = all().find((c) => c.id === params.id);
        if (!row) return err(404, 'unknown_conversation');
        if (query.get('fail')) return err(503, 'no_llm');
        const b = obj(body);
        const text = b.text;
        if (typeof text !== 'string' || text.trim() === '' || text.length > 8000 || Object.keys(b).some((k) => !['text', 'look', 'no_memory', 'scope_id'].includes(k))) return err(400, 'invalid_text');
        for (const k of ['look', 'no_memory']) if (k in b && typeof b[k] !== 'boolean') return err(400, `invalid_${k}`);
        if ('scope_id' in b && (typeof b.scope_id !== 'string' || b.scope_id.length < 1 || b.scope_id.length > 128 || b.no_memory === true)) return err(400, 'invalid_scope_id');
        if (row.archived) return err(409, 'archived');
        if (row.character_id !== present()) return ok(409, { error: 'character_not_present', character_id: row.character_id });
        if (row.id !== S1 && actives[row.character_id] !== row.id) return err(409, 'conversation_not_active');
        const line_id = (0x7a1e5c0b9d24 + lines++).toString(16);
        said?.({ line_id, conversation_id: row.id, character_id: row.character_id });
        return ok(202, { line_id, generation: 43, run_id: line_id, runtime: 'codex', ...(b.no_memory === true ? { runtime_reason: 'temporary_read_only' } : {}) });
      },
    },
    {
      method: 'POST',
      path: '/conversations/:id/cancel',
      handler: ({ body }) => {
        const b = obj(body);
        if (Object.keys(b).length !== 2 || typeof b.run_id !== 'string' || !Number.isInteger(b.generation)) return err(400, 'invalid_payload');
        return ok(202, { run_id: b.run_id, cancellation_requested: true });
      },
    },
    { method: 'POST', path: '/chat/prewarm', handler: () => ok(200, { ready: true }) },
  ];
}

export const routes: MockRoute[] = chatRoutes({ present: () => CHARACTER });
