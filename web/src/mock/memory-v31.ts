// The prototype's memory set (prototype-v3/pages/memory.js MEM3_*) in agentd's shapes. src/mock/memory.ts serves it to
// the memory page's own demos, so the page can be compared with the prototype side by side; no routes of its own.
import type { WireFact } from '../domain/wire';
import { at, DAY, NOW } from './fixtures/clock';
import { CHARACTER, E1, E2, E3, v31Id } from './fixtures/ids';

type Kind = WireFact['kind'];
type Source = WireFact['source'];
/** Where the prototype says a fact came from: a chat line (month, day, h, m, quote) or an episode (id, date). */
type Origin = { chat: [number, number, number, number, string] } | { ep: number; date?: string };

interface Seed {
  key: string;
  kind: Kind;
  text: string;
  src: Source;
  /** Days since the current version was written. */
  upd: number;
  uses: number;
  /** Uses in the last 14 days. */
  n14: number;
  /** Days since the last use. */
  idle: number;
  origin: Origin;
  candidate?: boolean;
  /** The character it is private to; absent: shared. */
  owner?: string;
}

const TODAY = '2026-10-29';
const S = (ms: number) => ms / 1000;
const day = (m: number, d: number, h: number, min: number) => new Date(2026, m - 1, d, h, min).getTime();

export { v31Id };
/** The chat line (agent_run ref and memory run id) a chat-sourced fact was read from. */
const lineOf = (key: string) => `turn-${key}`;

/** The prototype's mem3Spark: per-day use counts over 14 days (index 13 = today), seeded by key, the last `idle` days empty. */
function spark(key: string, n: number, idle: number): number[] {
  const out = Array<number>(14).fill(0);
  if (!n || idle >= 14) return out;
  let s = [...key].reduce((a, c) => a + c.charCodeAt(0) * 7, 3);
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const last = 13 - idle;
  out[last] = 1;
  for (let k = 1; k < n; k++) {
    const i = Math.floor(Math.pow(rnd(), 0.6) * (last + 1));
    out[i] = (out[i] ?? 0) + 1;
  }
  return out;
}

const TODAY_TIMES: Array<[number, number]> = [[14, 22], [11, 40], [10, 7], [9, 30], [9, 12]];
const PAST_TIMES: Array<[number, number]> = [[16, 0], [11, 0], [21, 0], [9, 40]];

/** Use times newest first: the 14-day spark, then the older uses from the idle day back. */
function useTimes(seed: Seed): number[] {
  const out: number[] = [];
  const sp = spark(seed.key, seed.n14, seed.idle);
  for (let i = 13; i >= 0; i--) {
    const ago = 13 - i;
    for (let j = 0; j < sp[i]!; j++) {
      const [h, m] = (ago === 0 ? TODAY_TIMES : PAST_TIMES)[j % 4]!;
      out.push(at(h, m) - ago * DAY);
    }
  }
  const from = Math.max(seed.idle, 14);
  for (let k = 0; out.length < seed.uses; k++) out.push(at(10, 30) - (from + k) * DAY);
  return out.filter((t) => t <= NOW).sort((a, b) => b - a);
}

function evidenceOf(s: Seed): string[] {
  if ('chat' in s.origin) return [`agent_run:${lineOf(s.key)}`];
  return [`episode:${s.origin.ep}@${s.origin.date ?? TODAY}`];
}

function wire(s: Seed): WireFact {
  const times = useTimes(s);
  const midnight = at(0, 0);
  const recorded = s.upd > 0 ? at(21, 30) - s.upd * DAY : s.key === 'x1' ? at(11, 52) : at(14, 20);
  return {
    fact_id: v31Id(s.key),
    version: s.upd === 0 && s.key === 'a3' ? 2 : 1,
    owner: s.owner ?? null,
    kind: s.kind,
    text: s.text,
    source: s.src,
    state: s.candidate ? 'candidate' : 'active',
    evidence: evidenceOf(s),
    occurred_at: null,
    recorded_at: S(s.candidate ? recordedCandidate(s) : recorded),
    last_used_at: times[0] != null ? S(times[0]) : null,
    stale: false,
    score: s.src === 'observed_context' || s.src === 'inferred_hypothesis' ? 0.58 : 0,
    uses_today: times.filter((t) => t >= midnight).length,
    last_injected_at: times[0] != null ? S(times[0]) : null,
    last_mentioned_at: times[2] != null ? S(times[2]) : null,
    recent_uses: times.slice(0, 5).map((t, i) => ({ line_id: `l-${s.key}-${i}`, at: S(t), mode: i % 3 === 2 ? 'mentioned' : 'injected' })),
  };
}

const recordedCandidate = (s: Seed) => ('chat' in s.origin ? day(...(s.origin.chat.slice(0, 4) as [number, number, number, number])) : at(11, 30));

const chat = (m: number, d: number, h: number, min: number, quote: string): Origin => ({ chat: [m, d, h, min, quote] });

const SEEDS: Seed[] = [
  { key: 'a1', kind: 'name', text: '小林', src: 'confirmed_by_user', upd: 21, uses: 31, n14: 18, idle: 0, origin: chat(10, 8, 20, 14, '叫我小林就行。') },
  { key: 'a2', kind: 'birthday', text: '3月2日', src: 'confirmed_by_user', upd: 21, uses: 1, n14: 0, idle: 40, origin: chat(10, 8, 20, 16, '我生日是 3 月 2 号。') },
  { key: 'a3', kind: 'fact', text: '在 Endfield 仓库开发角色应用，主要改 app/ 和 agent/', src: 'observed_context', upd: 0, uses: 9, n14: 9, idle: 0, origin: { ep: E3 } },
  { key: 'a4', kind: 'fact', text: '时区：上海', src: 'confirmed_by_user', upd: 21, uses: 4, n14: 3, idle: 2, origin: chat(10, 8, 20, 18, '对，我在上海。') },
  { key: 'p1', kind: 'preference', text: '回答先给结论，再给细节', src: 'asserted_by_user', upd: 11, uses: 12, n14: 10, idle: 0, origin: chat(10, 18, 10, 2, '先说结论，细节放后面。') },
  { key: 'p2', kind: 'preference', text: '晚上 10 点后不主动提醒', src: 'asserted_by_user', upd: 14, uses: 2, n14: 2, idle: 9, origin: chat(10, 15, 22, 31, '十点以后别提醒我了。') },
  { key: 'p3', kind: 'preference', text: '长测试交给 Codex，重构交给 Claude Code', src: 'inferred_hypothesis', upd: 5, uses: 4, n14: 4, idle: 1, origin: { ep: 1150, date: '2026-10-24' } },
  { key: 'p4', kind: 'preference', text: '查文档常用 developer.apple.com', src: 'observed_context', upd: 0, uses: 2, n14: 2, idle: 0, origin: { ep: E2 } },
  { key: 'p5', kind: 'preference', text: '咖啡不加糖', src: 'asserted_by_user', upd: 29, uses: 3, n14: 0, idle: 33, origin: chat(9, 30, 9, 12, '咖啡别加糖。') },
  { key: 'g1', kind: 'agreement', text: '每周五下午写周报', src: 'confirmed_by_user', upd: 1, uses: 3, n14: 2, idle: 0, origin: chat(10, 24, 16, 5, '对，周五下午写。') },
  { key: 'g2', kind: 'agreement', text: '提交前先跑 swift test', src: 'asserted_by_user', upd: 8, uses: 6, n14: 6, idle: 0, origin: chat(10, 21, 18, 40, '以后提交前先跑一遍 swift test。') },
  { key: 'g3', kind: 'agreement', text: '超过 10 分钟的任务完成后出声提醒', src: 'confirmed_by_user', upd: 11, uses: 5, n14: 5, idle: 1, origin: chat(10, 18, 11, 20, '长任务跑完叫我一声。') },
  { key: 'x1', kind: 'experience', text: '10-27 改了 HostLink 心跳超时，之后开始断线', src: 'observed_context', upd: 0, uses: 3, n14: 3, idle: 0, origin: { ep: E1 } },
  { key: 'x2', kind: 'experience', text: '近期在调 Metal 角色渲染的帧率', src: 'inferred_hypothesis', upd: 0, uses: 1, n14: 1, idle: 0, origin: chat(10, 29, 10, 7, '帧率掉到 40 了，帮我看看 P95。') },
  { key: 'x3', kind: 'experience', text: '周报 v1 按日期分组，曾被要求重写', src: 'confirmed_by_user', upd: 6, uses: 2, n14: 2, idle: 6, origin: chat(10, 23, 17, 45, '按日期分不好看，重写。') },
  { key: 'x4', kind: 'experience', text: '10 月中旬搬家', src: 'asserted_by_user', upd: 32, uses: 2, n14: 0, idle: 32, origin: chat(10, 15, 22, 20, '下周搬家，帮我列个清单。') },
  { key: 'o1', kind: 'preference', text: '她提醒我时只说一句，不展开', src: 'asserted_by_user', upd: 4, uses: 2, n14: 2, idle: 1, origin: chat(10, 25, 9, 20, '你提醒我的时候一句话就行。'), owner: CHARACTER },
  { key: 'o2', kind: 'agreement', text: '和她约好：周五下班前一起收个尾', src: 'confirmed_by_user', upd: 3, uses: 1, n14: 1, idle: 2, origin: chat(10, 26, 18, 5, '周五下班前我们一起收个尾。'), owner: CHARACTER },
  { key: 'c1', kind: 'agreement', text: '周报按项目分组，不按日期', src: 'inferred_hypothesis', upd: 0, uses: 0, n14: 0, idle: 0, origin: chat(10, 29, 14, 22, '按项目分组，不要按日期。'), candidate: true },
  { key: 'c2', kind: 'preference', text: '写代码时减少主动发言', src: 'inferred_hypothesis', upd: 0, uses: 0, n14: 0, idle: 0, origin: { ep: E3 }, candidate: true },
  { key: 'c3', kind: 'fact', text: '构建习惯用 swift build -c release', src: 'observed_context', upd: 0, uses: 0, n14: 0, idle: 0, origin: { ep: E3 }, candidate: true },
];

const SPARSE_KEYS = ['a1', 'a3', 'p1', 'p2', 'g1', 'x1'];

/** `GET /memory` facts of the prototype's 正常 demo. */
export const V31_FACTS: WireFact[] = SEEDS.map(wire);

/** The 数据少 demo: six facts with few uses, no candidates. */
export const V31_SPARSE_FACTS: WireFact[] = SEEDS.filter((s) => SPARSE_KEYS.includes(s.key)).map((s) =>
  wire({ ...s, upd: Math.min(s.upd, 2), uses: Math.min(s.uses, 3), n14: Math.min(s.n14, 3), idle: Math.min(s.idle, 1) }),
);

type Op = ['add' | 'correct' | 'forget', string | null, string, string?];

const extractRun = (id: string, finished: number, ops: Op[]) => ({
  run_id: id,
  backend: 'claude_agent_sdk',
  model: 'claude-haiku-4-5',
  character_id: 'si',
  started_at: S(finished) - 40,
  finished_at: S(finished),
  state: 'committed',
  prompt_version: 'memory_extract-v2',
  redacted_reason: null,
  input_sha256: 'b41c07',
  events: [],
  detail: {
    user_input: '',
    request: '',
    request_truncated: false,
    output: null,
    proposals: ops.map(([operation, key, text, was]) => ({
      proposal: { operation, text, evidence_quote: '', ...(was ? { target_quote: was } : {}) },
      receipt: { outcome: operation === 'forget' ? 'deleted' : 'stored', fact_id: key ? v31Id(key) : null, version: 1 },
    })),
  },
});

const R3 = extractRun('mrun-v31-r3', at(14, 20), [
  ['add', 'x2', '近期在调 Metal 角色渲染的帧率'],
  ['add', 'p4', '查文档常用 developer.apple.com'],
  ['correct', 'a3', '在 Endfield 仓库开发角色应用，主要改 app/ 和 agent/', '在 Endfield 仓库工作'],
]);
const R2 = extractRun('mrun-v31-r2', at(11, 52), [
  ['add', 'x1', '10-27 改了 HostLink 心跳超时，之后开始断线'],
  ['forget', null, '在用 Xcode 15 beta'],
]);
const R1 = extractRun('mrun-v31-r1', at(21, 30) - DAY, [
  ['correct', 'g1', '每周五下午写周报', '周五写周报'],
  ['correct', 'p3', '长测试交给 Codex，重构交给 Claude Code', '常用 Codex'],
]);
const R2_SPARSE = extractRun('mrun-v31-s2', at(11, 52), [['add', 'x1', '10-27 改了 HostLink 心跳超时，之后开始断线']]);

/** The chat turn each chat-sourced fact was read from, as a conversation run whose detail quotes the line. */
const CHAT_RUNS = SEEDS.flatMap((s) => {
  if (!('chat' in s.origin)) return [];
  const [m, d, h, min, quote] = s.origin.chat;
  const started = S(day(m, d, h, min));
  const proposal = { proposal: { operation: 'add', text: s.text, evidence_quote: quote }, receipt: { outcome: s.candidate ? 'candidate' : 'stored', fact_id: v31Id(s.key), version: 1 } };
  return [{ ...extractRun(lineOf(s.key), day(m, d, h, min), []), started_at: started, finished_at: started + 9, state: 'completed', prompt_version: 'conversation-v2', detail: { user_input: quote, request: '', request_truncated: false, output: null, proposals: [proposal] } }];
});

const DETAILS = [R3, R2, R1, R2_SPARSE, ...CHAT_RUNS];
const listRow = ({ input_sha256: _i, events: _e, detail: _d, ...row }: (typeof DETAILS)[number]) => row;
const newestFirst = (a: { started_at: number }, b: { started_at: number }) => b.started_at - a.started_at;

/** `GET /memory/runs` rows, newest first, for the 正常 and 数据少 demos. */
export const V31_RUNS = [R3, R2, R1, ...CHAT_RUNS].sort(newestFirst).map(listRow);
export const V31_SPARSE_RUNS = [R2_SPARSE, ...CHAT_RUNS.filter((r) => SPARSE_KEYS.some((k) => r.run_id === lineOf(k)))].sort(newestFirst).map(listRow);

/** `GET /memory/runs/{id}` of any run above. */
export const v31RunDetail = (id: string) => DETAILS.find((r) => r.run_id === id) ?? null;

/**
 * These have no agentd endpoint yet; the page's `full` demo reads this preview: earlier versions (oldest first, the
 * current text last), the facts the user locked by editing, and the ones marked 不再提及.
 */
export const V31_PREVIEW = {
  versions: {
    [v31Id('a3')]: [
      { text: '在 Endfield 仓库工作', when: '10月26日 21:30', by: '后台整理' },
      { text: '在 Endfield 仓库开发角色应用，主要改 app/ 和 agent/', when: '今天 14:20', by: '后台整理' },
    ],
    [v31Id('p1')]: [
      { text: '回答尽量简短', when: '10月12日 22:40', by: '后台推断' },
      { text: '回答先给结论，再给细节', when: '10月18日 10:03', by: '用户修改' },
    ],
    [v31Id('g1')]: [
      { text: '周五写周报', when: '10月17日 21:30', by: '后台推断' },
      { text: '每周五下午写周报', when: '10月24日 16:05', by: '用户确认' },
      { text: '每周五下午写周报', when: '昨天 21:30', by: '后台整理' },
    ],
    [v31Id('g2')]: [
      { text: '提交前跑测试', when: '10月21日 21:30', by: '后台整理' },
      { text: '提交前先跑 swift test', when: '10月21日 21:42', by: '用户修改' },
    ],
  } as Record<string, Array<{ text: string; when: string; by: string }>>,
  locked: [v31Id('p1'), v31Id('g2')],
  quiet: [v31Id('x4')],
};
