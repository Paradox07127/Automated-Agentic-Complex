import type { WireConversation, WireTurn } from '../domain/wire';
import { atS, DAY, WIRE_CONVERSATIONS, WIRE_CONVERSATIONS_BUSY } from './fixtures';
import { C1_TURNS, S1, SPARSE_CONV, SPARSE_TURNS } from './fixtures/chatDemo';
import type { MockResponse, MockRoute } from './types';
import { C1, C2, C3, C4, C5, C6, C7, C8, CHARACTER } from './fixtures/ids';

// Chat page endpoints in agentd's shapes (control_panel.py, conversations.py). `?fail=1` selects the error demos and
// `?demo=sparse` the one-conversation list; the page adds them only on the fake bridge.

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
  title,
  pinned: false,
  archived: true,
  revision: 3,
  created_at: atS(10, 0) - days * DAY_S,
  updated_at: atS(11, 0) - days * DAY_S,
  turn_count: 6,
  active: false,
});

/** C1 shows its last four turns of 13, so the replies read as turns 10–13. */
const ROWS: WireConversation[] = [
  ...WIRE_CONVERSATIONS.map((c) => (c.id === C1 ? { ...c, turn_count: 13 } : c)),
  archived(C6, '九月旅行计划', 30),
  archived(C7, '简历修改', 21),
  archived(C8, '读书笔记', 12),
];
const ALL = [...ROWS, SPARSE_CONV];

const TURNS: Record<string, WireTurn[]> = { [C1]: C1_TURNS, [S1]: SPARSE_TURNS, ...HISTORY };

/** conversations.py `turns` rows: history.py COLUMNS, without the conversation_id a /history row adds. */
const asTurn = ({ conversation_id: _c, ...t }: WireTurn): WireTurn => ({ ...t, raw_reply: t.raw_reply ?? null });

const ok = (status: number, body: unknown): MockResponse => ({ status, body });
const err = (status: number, error: string): MockResponse => ({ status, body: { error } });
const obj = (body: unknown): Record<string, unknown> => (body != null && typeof body === 'object' ? (body as Record<string, unknown>) : {});
const versioned = (body: unknown) => Number.isInteger(obj(body).expected_version);

export const routes: MockRoute[] = [
  {
    method: 'GET',
    path: '/conversations',
    handler: ({ query }) =>
      query.get('fail') ? err(503, 'no_history') : query.get('demo') === 'sparse' ? ok(200, { conversations: [SPARSE_CONV], busy: false }) : ok(200, { conversations: ROWS, busy: WIRE_CONVERSATIONS_BUSY }),
  },
  {
    method: 'GET',
    path: '/conversations/:id/turns',
    handler: ({ params }) => (ALL.some((c) => c.id === params.id) ? ok(200, { turns: (TURNS[params.id ?? ''] ?? []).map(asTurn), before: null }) : err(404, 'unknown_conversation')),
  },
  {
    method: 'POST',
    path: '/conversations',
    handler: ({ body }) => {
      if (WIRE_CONVERSATIONS_BUSY) return err(409, 'busy');
      const title = typeof obj(body).title === 'string' ? String(obj(body).title) : '新对话';
      const now = atS(14, 32, 10);
      return ok(201, { id: 'c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f9', title, pinned: false, archived: false, revision: 0, created_at: now, updated_at: now, turn_count: 0, active: true });
    },
  },
  {
    method: 'PUT',
    path: '/conversations/:id',
    handler: ({ params, body }) => {
      const row = ROWS.find((c) => c.id === params.id);
      if (!row) return err(404, 'unknown_conversation');
      const b = obj(body);
      if (!versioned(body) || Object.keys(b).length < 2) return err(400, 'invalid_conversation_update');
      const patch = Object.fromEntries((['title', 'pinned', 'archived'] as const).filter((k) => k in b).map((k) => [k, b[k]]));
      return ok(200, { ...row, ...patch, revision: Number(b.expected_version) + 1 });
    },
  },
  {
    method: 'DELETE',
    path: '/conversations/:id',
    handler: ({ params, body }) => {
      if (!ROWS.some((c) => c.id === params.id)) return err(404, 'unknown_conversation');
      if (!versioned(body)) return err(400, 'invalid_conversation_update');
      return WIRE_CONVERSATIONS_BUSY ? err(409, 'busy') : ok(200, { deleted: true });
    },
  },
  {
    method: 'POST',
    path: '/conversations/:id/activate',
    handler: ({ params, body }) => {
      const row = ROWS.find((c) => c.id === params.id);
      if (!row) return err(404, 'unknown_conversation');
      if (!versioned(body)) return err(400, 'invalid_conversation_update');
      if (row.archived) return err(409, 'archived');
      return WIRE_CONVERSATIONS_BUSY ? err(409, 'busy') : ok(200, { ...row, active: true, revision: Number(obj(body).expected_version) + 1 });
    },
  },
  {
    method: 'POST',
    path: '/conversations/:id/messages',
    handler: ({ params, query, body }) => {
      const row = ALL.find((c) => c.id === params.id);
      if (!row) return err(404, 'unknown_conversation');
      if (query.get('fail')) return err(503, 'no_llm');
      const b = obj(body);
      const text = b.text;
      if (typeof text !== 'string' || text.trim() === '' || text.length > 8000 || Object.keys(b).some((k) => !['text', 'look', 'no_memory'].includes(k))) return err(400, 'invalid_text');
      for (const k of ['look', 'no_memory']) if (k in b && typeof b[k] !== 'boolean') return err(400, `invalid_${k}`);
      if (row.archived) return err(409, 'archived');
      if (!row.active) return err(409, 'conversation_not_active');
      return ok(202, { line_id: '7a1e5c0b9d24', generation: 43, run_id: '7a1e5c0b9d24', runtime: 'codex', ...(b.no_memory === true ? { runtime_reason: 'temporary_read_only' } : {}) });
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
];
