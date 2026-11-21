// Memory, episodes, attention and history as agentd sends them.
import type { WireAttention, WireBrowser, WireEpisode, WireFact, WireTurn } from '../../../domain/wire';
import { at, atS, DAY, isoAt, NOW } from '../clock';
import { CHARACTER, E1, E2, E3, E4, E5, F1, F2, F3, F4, F5, F6, F7, F8 } from '../ids';

const DAY_S = DAY / 1000;
const daysAgoS = (n: number, h = 12, m = 0) => atS(h, m) - n * DAY_S;
const TODAY = '2026-10-29';

/** Episode ids (ints) of today's episodes; facts cite them as `episode:{id}@{date}`. */
export const EPISODE_IDS = { e1: E1, e2: E2, e3: E3, e4: E4, e5: E5 } as const;
const ep = (n: number) => `episode:${n}@${TODAY}`;

const use = (line_id: string, at: number, mode: 'injected' | 'mentioned') => ({ line_id, at, mode });

const fact = (f: Pick<WireFact, 'fact_id' | 'kind' | 'text' | 'source' | 'recorded_at'> & Partial<WireFact>): WireFact => ({
  version: 1,
  evidence: [],
  occurred_at: null,
  last_used_at: null,
  state: 'active',
  stale: false,
  score: 0,
  uses_today: 0,
  last_injected_at: null,
  last_mentioned_at: null,
  recent_uses: [],
  ...f,
});

/** `GET /memory` facts (active + candidates). Candidates get「确认 / 删除」by state, not by source. */
const FACTS: WireFact[] = [
  fact({
    fact_id: F1,
    kind: 'agreement',
    text: '周报按项目分组',
    source: 'inferred_hypothesis',
    state: 'candidate',
    recorded_at: atS(14, 22, 30),
    uses_today: 2,
    last_used_at: atS(14, 26),
    last_injected_at: atS(14, 26),
    last_mentioned_at: atS(14, 24),
    recent_uses: [use('l-8d03-2', atS(14, 26), 'injected'), use('l-8d03-1', atS(14, 24), 'mentioned')],
    score: 0.62,
    evidence: [ep(EPISODE_IDS.e5), 'agent_run:run-8d03'],
  }),
  fact({
    fact_id: F2,
    kind: 'fact',
    text: '在 Endfield 仓库工作，主要改 app/ 和 agent/',
    source: 'observed_context',
    recorded_at: daysAgoS(3, 10, 20),
    uses_today: 2,
    last_used_at: atS(14, 14),
    last_injected_at: atS(14, 14),
    recent_uses: [
      use('l-71a2-1', atS(14, 14), 'injected'),
      use('l-0c1', atS(9, 5), 'injected'),
      use('l-0b7', daysAgoS(1, 16), 'injected'),
      use('l-0a2', daysAgoS(2, 11), 'mentioned'),
      use('l-09c', daysAgoS(4, 10), 'injected'),
    ],
    score: 0.81,
    evidence: [ep(EPISODE_IDS.e1), ep(EPISODE_IDS.e3), ep(EPISODE_IDS.e5)],
  }),
  fact({
    fact_id: F3,
    kind: 'preference',
    text: '22:00 之后不要主动打扰',
    source: 'asserted_by_user',
    recorded_at: daysAgoS(8, 21, 5),
    last_used_at: daysAgoS(1, 22, 10),
    last_injected_at: daysAgoS(1, 22, 10),
    recent_uses: [use('l-0b9', daysAgoS(1, 22, 10), 'injected'), use('l-08f', daysAgoS(3, 21), 'injected')],
  }),
  fact({
    fact_id: F4,
    kind: 'fact',
    text: '构建习惯用 swift build -c release',
    source: 'observed_context',
    state: 'candidate',
    recorded_at: atS(11, 30),
    score: 0.38,
    evidence: [ep(EPISODE_IDS.e3)],
  }),
  fact({
    fact_id: F5,
    kind: 'agreement',
    text: '每周五下午写周报',
    source: 'confirmed_by_user',
    version: 2,
    recorded_at: daysAgoS(14, 16, 10),
    last_used_at: daysAgoS(12, 15, 0),
  }),
  fact({
    fact_id: F6,
    kind: 'preference',
    text: '回答先给结论，再给细节',
    source: 'asserted_by_user',
    recorded_at: daysAgoS(11, 9, 30),
    uses_today: 2,
    last_used_at: atS(14, 29),
    last_injected_at: atS(14, 29),
    last_mentioned_at: daysAgoS(3, 15),
    recent_uses: [
      use('l-8d03-3', atS(14, 29), 'injected'),
      use('l-8d03-0', atS(14, 22), 'injected'),
      use('l-0b8', daysAgoS(1, 17), 'injected'),
      use('l-0a5', daysAgoS(2, 12), 'injected'),
      use('l-095', daysAgoS(3, 15), 'mentioned'),
    ],
  }),
  fact({
    fact_id: F7,
    kind: 'experience',
    text: '最近在调 Metal 角色渲染的帧率',
    source: 'inferred_hypothesis',
    state: 'candidate',
    recorded_at: atS(10, 45),
    uses_today: 1,
    last_used_at: atS(11, 5),
    last_mentioned_at: atS(11, 5),
    recent_uses: [use('l-0c4', atS(11, 5), 'mentioned')],
    score: 0.44,
    evidence: [ep(EPISODE_IDS.e2)],
  }),
  fact({
    fact_id: F8,
    kind: 'preference',
    text: '咖啡不加糖',
    source: 'asserted_by_user',
    recorded_at: daysAgoS(41, 8, 40),
    last_used_at: daysAgoS(33, 9, 0),
    stale: true,
  }),
];
/** In agentd's order (server.py `_memory_read`): active facts, then candidates. */
export const WIRE_FACTS: WireFact[] = [...FACTS.filter((f) => f.state !== 'candidate'), ...FACTS.filter((f) => f.state === 'candidate')];

/** Top-level `paused` of `GET /memory`. */
export const WIRE_MEMORY_PAUSED = false;

const episode = (n: number, start: [number, number], end: [number, number], title: string, apps: string[], hosts?: string[]): WireEpisode => ({
  id: n,
  start: isoAt(...start),
  end: isoAt(...end),
  created_at: isoAt(...end),
  title,
  outcome: null,
  apps,
  ...(hosts ? { hosts } : {}),
});

/** `GET /episodes?date=2026-10-29` episodes. The last one is still being written, so it ends at the latest sample. */
export const WIRE_EPISODES: WireEpisode[] = [
  episode(EPISODE_IDS.e1, [9, 2], [9, 48], '在 Xcode 改 HostLink', ['Xcode']),
  episode(EPISODE_IDS.e2, [9, 55], [10, 40], '看 Metal 文档', ['Safari'], ['developer.apple.com']),
  episode(EPISODE_IDS.e3, [11, 0], [11, 45], '排查 HostLink 断线', ['Terminal', 'Xcode']),
  episode(EPISODE_IDS.e4, [13, 30], [14, 0], '飞书回复消息', ['飞书']),
  episode(EPISODE_IDS.e5, [14, 2], [14, 32], '写周报、跑测试', ['Terminal']),
];

const since = at(8, 40) / 1000;
const until = NOW / 1000;

/** `GET /attention/summary?by=app`: items only count overlap with active spans, so they sum to ≤ active_s. */
export const WIRE_ATTENTION_APP: WireAttention = {
  since,
  until,
  active_s: 16_030,
  afk_s: 4200,
  unknown_s: until - since - 16_030 - 4200,
  items: [
    { key: 'Terminal', seconds: 85 * 60 },
    { key: 'Xcode', seconds: 80 * 60 },
    { key: 'Safari', seconds: 45 * 60 },
    { key: '飞书', seconds: 30 * 60 },
    { key: '其他', seconds: 22 * 60 },
  ],
};

/** `GET /attention/summary?by=domain`: browser hosts, a subset of Safari's time. */
export const WIRE_ATTENTION_DOMAIN: WireAttention = {
  ...WIRE_ATTENTION_APP,
  items: [
    { key: 'developer.apple.com', seconds: 32 * 60 },
    { key: 'github.com', seconds: 9 * 60 },
    { key: 'docs.swift.org', seconds: 4 * 60 },
  ],
};

/** `GET /attention/browser`: the domain summary plus the extension reading a video page in the front window. */
export const WIRE_BROWSER: WireBrowser = {
  ...WIRE_ATTENTION_DOMAIN,
  connected: true,
  focused: true,
  current: {
    at: until - 4,
    url_host: 'developer.apple.com',
    scroll_percent: 42,
    max_scroll_percent: 68,
    tab_count: 9,
    audible_tab_count: 1,
    media: { kind: 'video', state: 'playing', position_s: 754, duration_s: 2310, playback_rate: 1.25, muted: false },
  },
  page_switches: 37,
  samples_received: 1204,
};

const hist = (n: number, source: string, user_text: string, reply: string, started_at: number, character_id = CHARACTER, conversation_id: string | null = null): WireTurn => ({
  id: n,
  event_id: `evt-${n}`,
  turn_id: `turn-${n}`,
  source,
  character_id,
  persona_revision: '3',
  user_text,
  reply,
  state: 'completed',
  started_at,
  ended_at: started_at + 8,
  raw_reply: null,
  conversation_id,
});

/** `GET /history` turns, newest first (`{turns, next}`). */
export const WIRE_HISTORY: WireTurn[] = [
  hist(309, 'text', '顺便查下 HostLink 断线是哪次提交引入的？', '初步看是 10-27 那组改 HostLink 心跳超时的提交……', atS(14, 29)),
  hist(305, 'text', '按项目分组，不要按日期。', '好，我按目录把提交归到 4 个项目里重写。', atS(14, 22)),
  hist(288, 'voice', '下午三点提醒我交报销单', '好，15:00 提醒你交报销单。', atS(13, 5)),
  hist(271, 'text', 'HostLink 又断了，帮我看看日志。', '日志里 11:38 心跳连续 3 次超时，之后重连成功……', atS(11, 40)),
  hist(240, 'text', '今天先到这', '好，明天见。', atS(21, 14) - DAY_S, 'voice_a'),
];
