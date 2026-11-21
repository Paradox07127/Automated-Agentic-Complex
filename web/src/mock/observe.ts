// 观察页 `full` demo 的数据：`GET /attention/events` 还没有，routes.json 里也没有这条路由，所以不注册它的 mock 路由，
// 只导出数据给页面在假桥的 full demo 里画应用细条、按小时柱、截图点和暂停斜纹。时间和记忆页 fixtures 的活动片段对齐。
// 文件末尾是持续观察几条路由（character_agent/routes/observation_http.py、observation_briefs_http.py）的回包；观察页的「简报」区块和设置 › 隐私读写简报这几条。
import type {
  ObservationBriefsResponse,
  ObservationBriefsSettingsResponse,
  ObservationSourcesResponse,
  ObservationStateResponse,
} from '../bridge/agentd-routes.generated';
import { at, atS, MINUTE } from './fixtures';
import { CHARACTER } from './fixtures/ids';
import type { MockResponse, MockRoute } from './types';
import type { ObsSegment, ObsShot } from '../pages/observe/model';

/** Foreground window title per app (the screenshot hover card). */
export const OBS_TITLES: Readonly<Record<string, string>> = {
  Terminal: 'Terminal — ~/Endfield/app — swift test',
  Xcode: 'Xcode — HostLink.swift',
  Safari: 'Safari — MTLRenderPipelineState | Apple Developer',
  Zoom: 'Zoom 会议 — 周会',
  飞书: '飞书 — 消息',
};

/** Foreground app spans today (bucket=app); 12:10–13:05 the user was away. */
export const OBS_SEGMENTS: ObsSegment[] = (
  [
    ['Xcode', 9, 2, 9, 30],
    ['Terminal', 9, 30, 9, 40],
    ['Xcode', 9, 40, 9, 48],
    ['Safari', 9, 55, 10, 36],
    ['Xcode', 10, 36, 10, 40],
    ['Terminal', 11, 0, 11, 18],
    ['Xcode', 11, 18, 11, 35],
    ['Terminal', 11, 35, 11, 45],
    ['Zoom', 11, 50, 12, 10],
    ['飞书', 13, 30, 13, 58],
    ['Terminal', 14, 2, 14, 18],
    ['Safari', 14, 18, 14, 26],
    ['Terminal', 14, 26, 14, 32],
  ] as const
).map(([app, h0, m0, h1, m1], i) => ({
  id: `s${i}`,
  app,
  t0: at(h0, m0),
  t1: at(h1, m1),
}));

/** One screenshot every 6 minutes inside the foreground spans, thinned evenly to `n` (37 = today's budget used). */
export function obsShots(segs: ReadonlyArray<ObsSegment>, n: number): ObsShot[] {
  const all: ObsShot[] = [];
  for (const s of segs) for (let t = s.t0 + MINUTE; t < s.t1; t += 6 * MINUTE) all.push({ t, app: s.app });
  if (all.length <= n) return all;
  return Array.from({ length: n }, (_, i) => all[Math.round((i * (all.length - 1)) / (n - 1))]!);
}

/** Screenshot requests the collector refused today. */
export const OBS_BLOCKED: Array<{ t: number; why: string }> = [
  { t: at(10, 21), why: '无痕窗口，始终排除' },
  { t: at(13, 44), why: '窗口标题含「工资」' },
  { t: at(14, 9), why: '本小时截图额度已满' },
];

/** `paused` demo: observation paused at 14:12 for an hour. */
export const OBS_PAUSE = { from: at(14, 12), until: at(15, 12) };

const ok = (body: unknown): MockResponse => ({ status: 200, body });

const FAILED = 'obs-5c1d9e2a7b3f4c6d8e0a1b2c3d4e5f60';
const PASSED = 'obs-6d2e0f3b8c4a5d7e9f1b2c3d4e5f6a71';
const PAGE = { type: 'page', ts: atS(14, 31, 40), url_host: 'github.com', title: 'CI 运行', tab_id: 3 };
const quote = [{ observation_id: FAILED, quote: 'render_test' }];

const STATE: ObservationStateResponse = {
  available: true,
  character_id: CHARACTER,
  processing_character_id: null,
  state: 'current',
  error: null,
  interpreted_at: atS(14, 30, 2),
  pending_sources: 1,
  queue: { by_origin: { browser: 1 }, all_characters: { [CHARACTER]: 1 }, oldest_pending_age_seconds: 30, exact_replay_aliases: 0, expired_fresh: 0, batch_source_limit: 128, batch_char_budget: 64000 },
  last_batch: { selected: 1, pending_before: 1, serialized_source_chars: 308, oldest_observed_at: atS(14, 29, 50), newest_observed_at: atS(14, 29, 50), duration_ms: 6400 },
  observed_at: atS(14, 31, 40),
  tasks: [
    {
      task_key: 'fix-render-test',
      title: '修复渲染测试',
      objective: '让 CI 通过',
      current_step: '查看失败日志',
      state: 'investigating',
      unresolved: ['超时原因'],
      next_steps: ['本地重跑'],
      confidence: 0.6,
      evidence: quote,
      last_interpreted_at: atS(14, 30, 2),
      last_observed_at: atS(14, 29, 50),
      id: 'hyp-3f0c1a2b4d5e6f708192a3b4c5d6e7f8',
      revision: 1,
    },
  ],
  observed_facts: [{ text: 'CI 构建失败', evidence: quote }],
  uncertainties: ['未看到本地日志'],
  task_corrections: { 'other-task': { revision: 2, action: 'reject', text: null } },
  current_sources: [
    { id: PASSED, origin: 'browser', revision: '5906d43b36160f8bf10b6c3624595752e31c79f42c4718c37278539942b507b4', metadata: PAGE, total_chars: 6, preview: '本地重跑通过', preview_complete: true },
  ],
  authority: 'observed_analysis',
  not_user_authorization: true,
};

const SOURCES: ObservationSourcesResponse = {
  items: [
    { id: PASSED, revision: '5906d43b36160f8bf10b6c3624595752e31c79f42c4718c37278539942b507b4', origin: 'browser', at: atS(14, 31, 40), metadata: PAGE, total_chars: 6, excerpt: '本地重跑通过' },
    { id: FAILED, revision: 'd042161abb1a64b9dd55f2ea59f33581cb5e51cd13aceefbd0aa9fe1e83dc1e2', origin: 'browser', at: atS(14, 29, 50), metadata: PAGE, total_chars: 19, excerpt: '构建失败：render_test 超时' },
  ],
  next_cursor: null,
  coverage: 'retained_authorized_observations_and_work_events',
};

const WORK_ID = 'work-9d8c7b6a5f4e3d2c1b0a998877665544';
const WORK = {
  title: '核对渲染测试结果',
  summary: '对比构建失败和本地重跑结果，确认重跑通过，仍需核对集成门禁。',
  state: 'result_observed',
  evidence: [{ observation_id: PASSED, quote: '本地重跑通过' }, { observation_id: FAILED, quote: '构建失败' }],
};
const WORK_SOURCE = {
  id: WORK_ID, revision: WORK_ID, origin: 'work_event', at: atS(14, 32),
  metadata: { title: WORK.title, summary: WORK.summary, state: WORK.state },
  total_chars: JSON.stringify(WORK).length, excerpt: JSON.stringify(WORK),
};

/** observation_briefs.py DEFAULTS. */
const SETTINGS: ObservationBriefsSettingsResponse = { enabled: true, daily: true, weekly: true, hour: 9, timezone: 'America/New_York' };

const SEGMENTS = ['segment:seg-8cf7a49da1084eb8a4561230bbe6523d', 'segment:seg-be3b667196ee4860a0e9b9aca0f32a7a'];
const refs = SEGMENTS.map((source_id) => ({ source_id, quote: '预算报告' }));

type Brief = ObservationBriefsResponse['reports'][number];

/** Yesterday's daily brief (2026-10-28 in America/New_York) and last week's (from Monday 2026-10-19). */
const BRIEFS: ObservationBriefsResponse = {
  settings: SETTINGS,
  attempts: [],
  reports: [
    {
      id: 'brief-060021117a99a52a5f7164e80ab20970',
      state: 'completed',
      period: 'daily',
      date: '2026-10-28',
      timezone: 'America/New_York',
      start: 1793160000,
      end: 1793246400,
      character_id: CHARACTER,
      generated_at: atS(9, 0, 4),
      run_id: 'semantic-acc0d51512d4474db9a487ae24726a9f',
      backend: 'codex',
      model: 'gpt-5-mini',
      authority: 'observed_analysis',
      next_steps_are_suggestions: true,
      coverage: {
        sampled: true,
        source_count: 2,
        candidate_rows_examined: 2,
        work_event_index: [],
        input_char_limit: 12000,
        scope: 'retained authorized Agentic Complex summaries and activity keywords; not complete computer history',
      },
      observed_details: [{ detail: '在改预算报告', evidence: refs.slice(0, 1) }],
      recurring_problems: [{ problem: '预算报告反复返工', optimization: '先定模板', evidence: refs }],
      next_steps: [{ action: '核对来源', reason: '数据待核验', evidence: refs.slice(0, 1) }],
      unknowns: ['覆盖不全'],
    },
    {
      id: 'brief-7b1d1f6f52c64a8f9e0d3c2b1a090807',
      state: 'completed',
      period: 'weekly',
      date: '2026-10-19',
      timezone: 'America/New_York',
      start: 1792382400,
      end: 1792987200,
      character_id: CHARACTER,
      generated_at: 1792998000,
      run_id: 'semantic-5e2a9c7d1b3f4e6a8c0d2f4b6a8e0c1d',
      backend: 'codex',
      model: 'gpt-5-mini',
      authority: 'observed_analysis',
      next_steps_are_suggestions: true,
      coverage: {
        sampled: true,
        source_count: 2,
        candidate_rows_examined: 9,
        work_event_index: [],
        input_char_limit: 22000,
        scope: 'retained authorized Agentic Complex summaries and activity keywords; not complete computer history',
      },
      observed_details: [{ detail: '这周大半时间在排查 HostLink 断线', evidence: [{ source_id: SEGMENTS[1]!, quote: 'HostLink' }] }],
      recurring_problems: [],
      next_steps: [{ action: '给断线重连补一条测试', reason: '同一问题出现了两次', evidence: [{ source_id: SEGMENTS[1]!, quote: 'HostLink' }] }],
      unknowns: ['周末没有记录'],
    },
  ],
};

/** The page's `?state=` demo: the requests themselves carry no demo. */
const demoState = () => new URLSearchParams((globalThis.location?.hash ?? '').split('?')[1] ?? '').get('state');

const briefOf = (id: string | undefined): Brief | undefined => BRIEFS.reports.find((r) => r.id === id);

export const routes: MockRoute[] = [
  { method: 'GET', path: '/observation/state', handler: ({ query }) => ok(query.get('demo') === 'unauthorized' ? { available: false, state: 'paused', tasks: [] } : STATE) },
  {
    method: 'GET', path: '/observation/sources', handler: ({ query }) => {
      const kind = query.get('kind');
      if (demoState() === 'empty') return ok({ ...SOURCES, items: [] });
      const items = kind === 'work_events' ? [WORK_SOURCE] : kind === 'raw' ? SOURCES.items : [WORK_SOURCE, ...SOURCES.items];
      const phrase = query.get('query')?.trim().toLowerCase() ?? '';
      return ok({ ...SOURCES, items: items.filter((item) => `${item.metadata.title} ${item.excerpt}`.toLowerCase().includes(phrase)) });
    },
  },
  {
    method: 'GET', path: '/observation/sources/:id', handler: ({ params }) => {
      const text = params.id === WORK_ID ? JSON.stringify(WORK) : SOURCES.items.find((item) => item.id === params.id)?.excerpt;
      return ok(text ? { text, next_offset: null } : { error: { code: 'source_unavailable' } });
    },
  },
  { method: 'GET', path: '/observation/briefs', handler: () => ok(BRIEFS) },
  // Before /settings: the later of two matching patterns wins.
  {
    method: 'GET',
    path: '/observation/briefs/:id',
    handler: ({ params }) => {
      const r = briefOf(params.id);
      return r ? ok(r) : { status: 404, body: { error: 'brief_not_found' } };
    },
  },
  { method: 'GET', path: '/observation/briefs/settings', handler: () => ok(SETTINGS) },
  { method: 'POST', path: '/observation/briefs/settings', handler: ({ body }) => ok({ ...SETTINGS, ...(body as object) }) },
  { method: 'POST', path: '/observation/briefs', handler: () => ({ status: 202, body: { id: 'brief-9d8c7b6a5f4e3d2c1b0a998877665544', state: 'scheduled' } }) },
  { method: 'DELETE', path: '/observation/briefs/:id', handler: ({ params }) => ok({ id: params.id, state: 'dismissed' }) },
];
