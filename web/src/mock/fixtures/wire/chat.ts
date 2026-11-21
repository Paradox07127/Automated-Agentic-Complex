// Conversations and their turns as agentd sends them (conversations.py list(), turns()).
import type { WireConversation, WireTurn } from '../../../domain/wire';
import { atS, DAY } from '../clock';
import * as id from '../ids';

const DAY_S = DAY / 1000;

const conv = (c: Pick<WireConversation, 'id' | 'title' | 'updated_at'> & Partial<WireConversation>): WireConversation => ({
  pinned: false,
  archived: false,
  revision: 1,
  created_at: c.updated_at - 3600,
  turn_count: 4,
  active: false,
  ...c,
});

/** `GET /conversations` rows (pinned first, then newest). C1 is the active one; the list's top-level `busy` is true. */
export const WIRE_CONVERSATIONS: WireConversation[] = [
  conv({ id: id.C1, title: '周报整理', pinned: true, active: true, revision: 6, created_at: atS(14, 14), updated_at: atS(14, 31), turn_count: 5 }),
  conv({ id: id.C2, title: 'HostLink 断线排查', updated_at: atS(11, 40), revision: 2 }),
  conv({ id: id.C3, title: '十月开销汇总', updated_at: atS(9, 12) }),
  conv({ id: id.C4, title: 'Metal 帧率调优', updated_at: atS(16, 5) - 2 * DAY_S, revision: 3 }),
  conv({ id: id.C5, title: '搬家清单', updated_at: atS(20, 40) - 8 * DAY_S }),
];

/** Top-level `busy` of `GET /conversations`. */
export const WIRE_CONVERSATIONS_BUSY = true;

const turn = (n: number, turn_id: string, user_text: string, reply: string, started_at: number, ended_at: number | null, source = 'text', state = 'completed'): WireTurn => ({
  id: n,
  event_id: `evt-${n}`,
  turn_id,
  source,
  character_id: id.CHARACTER,
  persona_revision: '3',
  user_text,
  reply,
  state,
  started_at,
  ended_at,
  conversation_id: id.C1,
});

/** `GET /conversations/{C1}/turns` (oldest first). */
export const WIRE_TURNS: WireTurn[] = [
  turn(301, 'tr8', '帮我整理这周的提交，出一份周报，放到 ~/Documents/周报。', '好，我先看这周 Endfield 仓库的提交记录，再按目录归到项目里。', atS(14, 14), atS(14, 14, 12)),
  turn(305, 'tr7', '按项目分组，不要按日期。', '改好了：Companion 58 条、agentd 41 条、渲染管线 29 条、其他 14 条。v2 已交付，待复核。', atS(14, 25, 51), atS(14, 26)),
];
