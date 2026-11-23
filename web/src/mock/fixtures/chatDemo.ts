// Chat page demos `full` and `sparse` (prototype chat.js CH_TR / CH_TR_SP): turn traces with the fields agentd does
// not send yet (judge choices on user turns, cache tokens and cost, motion length, observed window),
// the facts those turns used, and the cross-conversation history behind 全部台词.
import type { WireConversation, WireTraceTurn, WireTurn } from '../../domain/wire';
import { at, atS, DAY } from './clock';
import { isoWithOffset } from '../../domain/units';
import type { ChatDemoSource, DemoEvent, DemoFact } from '../../pages/chat/demoTypes';
import { C1, C2, C3, C4, CHARACTER } from './ids';

/** The sparse demo's only conversation. */
export const S1 = 'c5a1e0f9d8c7b6a5f4e3d2c1b0a9f8e7';

const FACT_TEXT: Record<string, string> = {
  f1: '周报按项目分组',
  f2: '在 Endfield 仓库工作，主要改 app/ 和 agent/',
  f4: '构建习惯用 swift build -c release',
  f6: '回答先给结论，再给细节',
};

const turn = (conversation_id: string, n: number, turn_id: string, source: string, user_text: string, reply: string, started_at: number, ended_at: number): WireTurn => ({
  id: n,
  event_id: `evt-${n}`,
  turn_id,
  source,
  character_id: CHARACTER,
  persona_revision: '3',
  user_text,
  reply,
  state: 'completed',
  started_at,
  ended_at,
  conversation_id,
});

/** `GET /conversations/{C1}/turns` (oldest first); turn ids match the `/trace/turns` rows, the 14:20 proactive line has none. */
export const C1_TURNS: WireTurn[] = [
  turn(C1, 401, 'tr8', 'text', '帮我整理这周的提交，出一份周报，放到 ~/Documents/周报。', '好，我先看这周 Endfield 仓库的提交记录，再按目录归到项目里。', atS(14, 14), atS(14, 14, 12)),
  turn(C1, 402, 'turn-c1-p20', 'proactive', '', '第一版按日期排好了，放在 ~/Documents/周报/2026-W44 周报.md。', atS(14, 20, 31), atS(14, 20, 34)),
  turn(C1, 403, 'tr7', 'text', '按项目分组，不要按日期。', '改好了：Companion 58 条、agentd 41 条、渲染管线 29 条、其他 14 条。v2 已交付，待复核。我接着生成提交统计表。', atS(14, 25, 51), atS(14, 26)),
  turn(C1, 404, 'tr3', 'text', '顺便查下 HostLink 断线是哪次提交引入的？', '初步看是 10-27 那组改 HostLink 心跳超时的提交。现在前台在跑周报任务，我只读看了提交记录；要细查的话，等周报结束后可以开一个任务。', atS(14, 29, 40), atS(14, 29, 46)),
];

export const SPARSE_CONV: WireConversation = { id: S1, character_id: CHARACTER, title: 'HostLink 早上', pinned: false, archived: false, revision: 1, created_at: atS(10, 2), updated_at: atS(11, 6), turn_count: 4, active: true, preview: '嗯，记下了：重连超时先保持 1.5 秒。' };

export const SPARSE_TURNS: WireTurn[] = [
  turn(S1, 501, 'turn-s1-1', 'text', '早，今天先排查 HostLink 的断线。', '早。昨晚 23:40 之后断过两次，日志我留着，要看的时候叫我。', atS(10, 2, 15), atS(10, 2, 18)),
  turn(S1, 502, 'turn-s1-2', 'proactive', '', '你在 Xcode 里待了 45 分钟了，起来走两步？', atS(10, 48, 40), atS(10, 48, 42)),
  turn(S1, 503, 'turn-s1-3', 'text', 'HostLink 重连超时现在是多少？', '1.5 秒，在 HostLink.swift 第 212 行。', atS(11, 5, 20), atS(11, 5, 23)),
  turn(S1, 504, 'turn-s1-4', 'text', '好，先不改。', '嗯，记下了：重连超时先保持 1.5 秒。', atS(11, 6, 2), atS(11, 6, 4)),
];

interface Proto {
  turn_id: string;
  start: number;
  ms: number;
  ttft?: number;
  src?: string;
  obs?: { app: string; title: string; shot: boolean };
  motion?: { name: string; ms: number };
  judge?: [number, number, number];
  model?: { name: string; in: number; cache: number; out: number; cost: number };
  fail?: 'tts';
  res?: string;
}

/** [span family, kind at start, kind at end, t0, duration] of a 3.4 s turn, scaled to the turn (prototype TI_TPL). */
const TPL: Array<[string, string, string, number, number]> = [
  ['input', '', 'input.received', 0, 40],
  ['ctx', 'context.started', 'context.assembled', 40, 380],
  ['mem', 'memory.recall_started', 'memory.recalled', 60, 180],
  ['obs', 'observation.requested', 'observation.settled', 90, 230],
  ['judge', 'judge.requested', 'judge.decided', 420, 340],
  ['model', 'model.started', 'model.finished', 760, 1840],
  ['line', '', 'line.parsed', 1340, 1300],
  ['tts', 'speech.requested', 'speech.first_audio', 1500, 800],
  ['play', 'playback.started', 'playback.ended', 2300, 1100],
  ['motion', 'motion.started', 'motion.ended', 2350, 1000],
];

function protoEvents(o: Proto): DemoEvent[] {
  const k = o.ms / 3400;
  const iso = (t: number) => isoWithOffset(o.start + Math.round(t));
  const model = o.model ?? { name: 'claude-sonnet-4-5', in: 2900, cache: 2300, out: 180, cost: 0.011 };
  const out: DemoEvent[] = [];
  let failEnd = Infinity;
  for (const [fam, startKind, endKind, t0r, dr] of TPL) {
    if ((fam === 'obs' && !o.obs) || (fam === 'motion' && !o.motion)) continue;
    const t0 = Math.round(t0r * k);
    if (t0 >= failEnd) continue;
    let dur = Math.max(4, Math.round(dr * k));
    if (fam === 'input') dur = 40;
    if (fam === 'tts' && o.fail === 'tts') {
      out.push({ kind: 'speech.requested', status: 'ok', t_wall: iso(t0), attrs: {} });
      out.push({ kind: 'speech.failed', status: 'failed', t_wall: iso(t0 + dur), attrs: { error: 'remote unreachable' } });
      failEnd = t0 + dur;
      continue;
    }
    if (fam === 'line' && o.ttft != null) {
      out.push({ kind: 'model.first_token', status: 'ok', t_wall: iso(o.ttft), attrs: {} });
      dur = Math.max(4, t0 + dur - o.ttft);
    }
    const lineT0 = fam === 'line' && o.ttft != null ? o.ttft : t0;
    if (startKind) out.push({ kind: startKind, status: 'ok', t_wall: iso(lineT0), attrs: fam === 'motion' && o.motion ? { clip: o.motion.name, duration_ms: o.motion.ms } : {} });
    const end = lineT0 + dur;
    const attrs: Record<string, unknown> =
      fam === 'input'
        ? { source: o.src ?? 'text' }
        : fam === 'obs' && o.obs
          ? { ...o.obs }
          : fam === 'judge'
            ? { backend: 'rules', answers: (['speak', 'wait', 'silent'] as const).map((id, i) => ({ id, value: i === 0, prob: (o.judge ?? [0.82, 0.12, 0.06])[i] })) }
            : fam === 'model'
              ? { model: model.name, input_tokens: model.in, output_tokens: model.out, cached_tokens: model.cache, cost_usd: model.cost, stop_reason: 'end_turn' }
              : fam === 'motion' && o.motion
                ? { clip: o.motion.name }
                : {};
    out.push({ kind: endKind, status: 'ok', t_wall: iso(fam === 'input' ? 40 : end), ...(startKind ? { duration_ms: end - lineT0 } : {}), attrs });
  }
  return out.sort((a, b) => Date.parse(a.t_wall) - Date.parse(b.t_wall));
}

const row = (conversation_id: string | null) => (o: Proto): WireTraceTurn => ({
  trace_id: `trace-${o.turn_id}`,
  turn_id: o.turn_id,
  source: o.src ?? 'text',
  head: null,
  len: null,
  producers: ['agentd', 'avatar'],
  started_at: isoWithOffset(o.start),
  result: o.res ?? (o.fail ? 'failed' : 'ok'),
  duration_ms: o.ms,
  conversation_id,
});

const FULL: Proto[] = [
  { turn_id: 'tr8', start: at(14, 14, 2), ms: 4800, ttft: 1800, obs: { app: 'Terminal', title: 'zsh · ~/Endfield', shot: true }, motion: { name: '思考', ms: 1600 }, judge: [0.91, 0.06, 0.03], model: { name: 'claude-sonnet-4-5', in: 2860, cache: 1920, out: 96, cost: 0.011 } },
  { turn_id: 'turn-c1-p20', start: at(14, 20, 31), ms: 2900, ttft: 1020, src: 'proactive', obs: { app: 'Terminal', title: 'python · ~/Documents/周报', shot: false }, motion: { name: '开口说话', ms: 2000 }, judge: [0.74, 0.2, 0.06], model: { name: 'claude-sonnet-4-5', in: 2410, cache: 2100, out: 64, cost: 0.008 } },
  { turn_id: 'tr7', start: at(14, 26, 2), ms: 3400, ttft: 1340, obs: { app: 'Terminal', title: 'python 统计 · ~/Documents/周报', shot: true }, motion: { name: '点头附和', ms: 1200 }, judge: [0.82, 0.12, 0.06], model: { name: 'claude-sonnet-4-5', in: 3120, cache: 2480, out: 220, cost: 0.0126 } },
  { turn_id: 'tr3', start: at(14, 29, 12), ms: 5200, ttft: 1620, obs: { app: 'Terminal', title: 'git log · ~/Endfield/app', shot: true }, fail: 'tts', judge: [0.88, 0.09, 0.03], model: { name: 'claude-sonnet-4-5', in: 3380, cache: 2600, out: 184, cost: 0.013 } },
];

const SPARSE: Proto[] = [
  { turn_id: 'turn-s1-1', start: at(10, 2, 15), ms: 2600, obs: { app: 'Xcode', title: 'HostLink.swift', shot: true }, motion: { name: '点头附和', ms: 1200 } },
  { turn_id: 'turn-s1-2', start: at(10, 48, 40), ms: 1900, src: 'proactive', obs: { app: 'Xcode', title: 'HostLink.swift', shot: false }, motion: { name: '伸懒腰', ms: 2400 }, judge: [0.71, 0.22, 0.07] },
  { turn_id: 'turn-s1-3', start: at(11, 5, 20), ms: 2300, src: 'desktop', obs: { app: 'Xcode', title: 'HostLink.swift', shot: true }, motion: { name: '开口说话', ms: 1500 } },
  { turn_id: 'turn-s1-4', start: at(11, 6, 2), ms: 1700, motion: { name: '点头附和', ms: 1200 } },
];

const uses = (ids: string[], mode: 'injected' | 'mentioned' = 'injected') => ids.map((line_id) => ({ line_id, at: atS(14, 0), mode }));
const facts = (used: Record<string, string[]>): DemoFact[] =>
  Object.keys(FACT_TEXT).map((id) => ({ fact_id: id, text: FACT_TEXT[id] ?? '', recent_uses: uses(used[id] ?? []) }));

/** Turns per hour of the last 24 h for a conversation (prototype CH_HR). */
const hourly = (counts: Record<number, number>, conv: string, base: number): WireTurn[] =>
  Object.entries(counts).flatMap(([h, n]) =>
    Array.from({ length: n }, (_, i) => {
      const t = atS(Number(h), Math.min(58, 3 + i * 7));
      return turn(conv, base + Number(h) * 10 + i, `turn-h-${conv.slice(0, 4)}-${h}-${i}`, 'text', '', '', t, t + 6);
    }),
  );

const LINES: WireTurn[] = [
  turn(C1, 404, 'tr3', 'text', '顺便查下 HostLink 断线是哪次提交引入的？', '初步看是 10-27 那组改 HostLink 心跳超时的提交。', atS(14, 29, 40), atS(14, 29, 46)),
  turn(C1, 403, 'tr7', 'text', '', '改好了：Companion 58 条、agentd 41 条、渲染管线 29 条、其他 14 条。', atS(14, 25, 51), atS(14, 26)),
  turn(C2, 271, 'turn-c2-7', 'text', '', '日志里 11:38 心跳连续 3 次超时，之后重连成功。', atS(11, 40), atS(11, 40, 8)),
  turn(C3, 181, 'turn-c3-3', 'text', '把十月的账单按类别汇总一下。', '', atS(9, 12), atS(9, 12, 6)),
  turn(C4, 121, 'turn-c4-41', 'text', '', 'P95 降到 15.6 ms 了，主要是阴影那一趟。', atS(16, 5) - (2 * DAY) / 1000, atS(16, 5, 8) - (2 * DAY) / 1000),
];

/** Filler turns carry no text; 全部台词 shows only lines with words. */
const FULL_HISTORY: WireTurn[] = [
  ...LINES,
  ...hourly({ 8: 1, 9: 2, 10: 1, 11: 2, 12: 1, 13: 2, 14: 5 }, C1, 1000),
  ...hourly({ 10: 3, 11: 5 }, C2, 2000),
  ...hourly({ 9: 3 }, C3, 3000),
].sort((a, b) => b.started_at - a.started_at);

export const CHAT_DEMO: Record<'full' | 'sparse', ChatDemoSource> = {
  full: {
    rows: FULL.map(row(C1)),
    events: Object.fromEntries(FULL.map((o) => [`trace-${o.turn_id}`, protoEvents(o)])),
    facts: facts({ f2: ['tr8', 'tr7', 'tr3'], f6: ['tr7'] }),
    learned: { 'tr7': ['f1'] },
    history: FULL_HISTORY,
    side: [{ t0: at(14, 29, 40), t1: at(14, 29, 46) }],
  },
  sparse: {
    rows: SPARSE.map(row(S1)),
    events: Object.fromEntries(SPARSE.map((o) => [`trace-${o.turn_id}`, protoEvents(o)])),
    facts: facts({ f2: ['turn-s1-3'] }),
    learned: { 'turn-s1-4': ['f4'] },
    history: [...SPARSE_TURNS].reverse(),
    side: [],
  },
};

/** The chat v2 prototype's topic 「应龙特勤队见面会」 (proto.js t2): bold, a list, inline code, a drawn picture and a link. */
export const MEETUP = 'ca0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d';

/** A training-ground sketch drawn for the demo; `(` `)` are escaped so the markdown link target stays whole. */
const SCENE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 400"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fb9c9"/><stop offset=".6" stop-color="#d9d2bd"/><stop offset="1" stop-color="#b9a884"/></linearGradient><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6b6a5c"/><stop offset="1" stop-color="#3c3b34"/></linearGradient></defs><rect width="680" height="400" fill="url(#s)"/><path d="M0 230l90-60 70 40 110-90 120 100 80-50 210 70v160H0z" fill="#7c8a8c" opacity=".6"/><path d="M0 270l140-40 160 30 180-50 200 40v150H0z" fill="url(#g)"/><g fill="#2c2d2a"><rect x="410" y="170" width="120" height="100"/><rect x="420" y="140" width="24" height="30"/><rect x="540" y="200" width="60" height="70"/></g><rect x="410" y="250" width="120" height="8" fill="#fff100"/><g fill="#161616"><circle cx="300" cy="300" r="7"/><rect x="295" y="306" width="10" height="22"/><circle cx="326" cy="304" r="6"/><rect x="321" y="309" width="10" height="19"/><circle cx="350" cy="302" r="6.5"/><rect x="345" y="308" width="10" height="20"/></g></svg>',
).replace(/\(/g, '%28').replace(/\)/g, '%29')}`;

const HANDBOOK = 'https://yinglong.example.org/handbook/new-members?season=2026-winter';

export const MEETUP_TURNS: WireTurn[] = [
  turn(MEETUP, 601, 'turn-meet-1', 'proactive', '', '咳咳，你在吗？', atS(13, 58), atS(13, 58, 3)),
  turn(MEETUP, 602, 'turn-meet-2', 'text', '嗯，我看到消息了。怎么了吗？', '应龙特勤队最近又有一批新队员来报到了，谈老让我抽个空去和他们见个面。\n\n特勤队刚成立时我答应过谈老，尽量对那些小辈们好一点。这回再逃，该挨她训了。\n\n你有空的话，陪我走一趟吧。', atS(13, 59), atS(13, 59, 6)),
  turn(MEETUP, 603, 'turn-meet-3', 'text', '可以啊，最近刚好没那么忙。', `真的？还算你有良心！\n\n我把场地和安排发你看看：\n- **时间**：周三下午三点\n- **地点**：三号训练场，见下图\n- 带上 \`新队员名单\`，到了先点名\n\n![三号训练场](${SCENE})\n\n入队须知在 [这里](${HANDBOOK})。`, atS(14, 0), atS(14, 0, 9)),
  turn(MEETUP, 604, 'turn-meet-4', 'proactive', '', '去了可不能白去啊，你得给我出点主意，该说点什么做点什么来鼓励鼓励那些年轻人。', atS(14, 2), atS(14, 2, 4)),
];

export const MEETUP_CONV: WireConversation = { id: MEETUP, character_id: CHARACTER, title: '应龙特勤队见面会', pinned: false, archived: false, revision: 1, created_at: atS(13, 58), updated_at: atS(14, 2, 4), turn_count: 4, active: false, preview: '' };

/** 示例甲 (`voice_a`), not on the desktop: her topics and their turns. */
export const OTHER = 'voice_a';
export const HANDOVER = 'da1e2f3a4b5c6d7e8f9a0b1c2d3e4f51';
const SHIFT = 'da2e3f4a5b6c7d8e9f0a1b2c3d4e5f62';
const OLD_PROTOCOL = 'da3e4f5a6b7c8d9e0f1a2b3c4d5e6f73';

const hers = (conversation_id: string, n: number, user_text: string, reply: string, started_at: number): WireTurn => ({
  ...turn(conversation_id, n, `turn-va-${n}`, user_text ? 'text' : 'proactive', user_text, reply, started_at, started_at + 4),
  character_id: OTHER,
});

export const OTHER_TURNS: Record<string, WireTurn[]> = {
  [HANDOVER]: [hers(HANDOVER, 701, '', '交接清单我放在共享目录了，你有空过一眼。', atS(9, 40) - 10 * DAY / 1000), hers(HANDOVER, 702, '收到，晚点看。', '不急。看完告诉我一声就行。', atS(9, 46) - 10 * DAY / 1000)],
  [SHIFT]: [hers(SHIFT, 711, '', '早。今天九点有站会，别忘了。', atS(7, 10) - 12 * DAY / 1000)],
  [OLD_PROTOCOL]: [hers(OLD_PROTOCOL, 721, '', '旧版那个问题已经不影响了。', atS(16, 40) - 29 * DAY / 1000)],
};

const herConv = (id: string, title: string, days: number, o: Partial<WireConversation> = {}): WireConversation => {
  const t = OTHER_TURNS[id] ?? [];
  return { id, character_id: OTHER, title, pinned: false, archived: false, revision: 1, created_at: (t[0]?.started_at ?? atS(9, 0)) - 60, updated_at: t.at(-1)?.ended_at ?? atS(9, 0) - days * DAY / 1000, turn_count: t.length, active: false, preview: '', ...o };
};

export const OTHER_CONVS: WireConversation[] = [
  herConv(HANDOVER, '协议核心的交接', 10, { active: true }),
  herConv(SHIFT, '早班的提醒', 12),
  herConv(OLD_PROTOCOL, '旧版协议的问题', 29, { archived: true }),
];
