// GET /brief/day?date=YYYY-MM-DD：今天按假数据钟点截断，前 6 天按日期种子缩放同一模板；请求或页面地址里的 sw=scr,voice 只开列出的开关（演示用）。
import { appNow } from '../bridge/clock';
import { ITEM_ORDER, ITEMS, type BriefDay, type BriefItemId, type BriefSwitch } from '../pages/overview/briefDay';
import type { MockRoute } from './types';

const SWITCHES: BriefSwitch[] = ['scr', 'read', 'shot', 'code', 'agent', 'voice'];
const z = (n: number) => Array.from({ length: n }, () => 0);
// 一天的模板，下标是钟点；8 点前和 22 点后是 0。
const SHAPE: Record<BriefItemId, number[]> = {
  done: [...z(10), 1, 2, 0, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0],
  err: [...z(10), 1, ...z(13)],
  turn: [...z(8), 1, 4, 3, 2, 1, 5, 4, 3, 2, 1, 0, 2, 3, 1, 0, 0],
  line: [...z(9), 4, 3, 5, 0, 6, 8, 5, 3, 2, 0, 2, 4, 1, 0, 0],
  fg: [...z(8), 12, 48, 55, 52, 20, 35, 58, 54, 50, 41, 18, 0, 22, 35, 10, 0],
  say: [...z(9), 1, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0],
  motion: [...z(8), 3, 6, 5, 7, 2, 6, 8, 9, 6, 5, 2, 0, 3, 4, 1, 0],
  touch: [...z(9), 2, 0, 1, 3, 1, 2, 0, 1, 0, 0, 1, 0, 0, 0, 0],
  voice: [...z(9), 50, 40, 60, 0, 70, 120, 80, 30, 20, 0, 20, 30, 0, 0, 0],
  mem: [...z(9), 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0],
  cost: [...z(24)],
  code: [...z(9), 2, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0],
  shot: [...z(8), 2, 6, 7, 5, 0, 4, 8, 5, 4, 3, 1, 0, 2, 3, 0, 0],
  mask: [...z(9), 2, 3, 1, 0, 2, 3, 1, 1, 0, 0, 1, 0, 0, 0, 0],
  rem: [...z(15), 1, ...z(5), 1, 0, 0],
};
const AVG: Record<BriefItemId, number> = { done: 5.1, err: 0.6, turn: 18, line: 27, fg: 340, say: 7, motion: 52, touch: 6, voice: 300, mem: 3.4, cost: 1.12, code: 4.3, shot: 41, mask: 9, rem: 1.6 };

const APPS: Array<[string, number]> = [['Visual Studio Code', 150], ['Terminal', 80], ['Chrome', 70], ['飞书', 40], ['Finder', 20], ['其他', 20]];
const APP_TOTAL = APPS.reduce((a, [, m]) => a + m, 0);
const SITES: Array<[string, number]> = [['github.com', 34], ['docs.python.org', 18], ['developer.apple.com', 12], ['stackoverflow.com', 9]];

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const seeded = (s: number) => () => ((s = (s * 9301 + 49297) % 233280), s / 233280);

function build(date: string, on: Record<BriefSwitch, boolean>): BriefDay {
  const now = appNow();
  const today = dayOf(now) === date;
  const nowHour = new Date(now).getHours() + new Date(now).getMinutes() / 60;
  const day0 = new Date(`${date}T00:00:00`).getTime() / 1000;
  const r = seeded(Number(date.replaceAll('-', '')));
  const k = today ? 1 : 0.6 + r() * 0.7;
  const has = (id: BriefItemId) => ITEMS[id].need.length === 0 || ITEMS[id].need.some((s) => on[s]);
  const items = Object.fromEntries(
    ITEM_ORDER.map((id) => {
      const hours = SHAPE[id].map((v, h) => (today && h > nowHour ? 0 : Math.round(v * k * (today ? 1 : 0.7 + r() * 0.6))));
      const enabled = has(id);
      const total = id === 'cost' ? +(1.31 * (today ? 0.64 : k)).toFixed(2) : hours.reduce((a, b) => a + b, 0);
      return [id, { enabled, today: enabled ? total : 0, hours: id === 'cost' || id === 'mask' ? null : enabled ? hours : z(24), avg7: AVG[id], yesterday: +(AVG[id] * 1.1).toFixed(id === 'cost' ? 2 : 0) }];
    }),
  ) as BriefDay['items'];
  return {
    date,
    partial: today,
    switches: on,
    items,
    focus: {
      enabled: on.scr,
      away_min: on.scr ? 65 : 0,
      longest: on.scr ? { start: day0 + 14 * 3600, minutes: 98 } : null,
      pauses: on.scr ? [[day0 + 12.17 * 3600, day0 + 12.83 * 3600]] : [],
      apps: on.scr ? APPS.map(([name, m]) => ({ name, minutes: Math.round((m * items.fg.today) / APP_TOTAL) })) : [],
      sites: on.scr && on.read ? SITES.map(([host, m]) => ({ host, minutes: Math.round(m * k) })) : [],
    },
    her: {
      said: { total: items.line.today, self: items.say.today, replied: Math.round(items.say.today * 0.6) },
      lines: [
        { at: day0 + 13.08 * 3600, kind: 'self', text: '发票归好了，7 张，都在「报销 11 月」。要我顺手把金额加一下吗？', note: '你回了「加吧」' },
        { at: day0 + 11.37 * 3600, kind: 'reply', text: 'pypdfium2 是 Apache-2.0，商用没问题。我记在笔记里了。', note: '回你的问题' },
        { at: day0 + 15.33 * 3600, kind: 'miss', text: '坐了一个半小时了，起来走两步？', note: '你没回' },
      ],
      touch: { pat: 3, pinch: 1, drag: 3, wheel: 2 },
      why: [
        { key: 'task_done', label: '做完一件事告诉你', count: 2 },
        { key: 'ask', label: '要你确认', count: 1 },
        { key: 'break', label: '久坐提醒', count: 1 },
        { key: 'comment', label: '闲聊', count: 1 },
      ],
      motions: [
        { key: 'idle_screen', label: '看屏幕（待机）', count: 12 },
        { key: 'stretch', label: '伸懒腰', count: 7 },
        { key: 'sit_top', label: '坐窗顶', count: 6 },
        { key: 'wave', label: '挥手', count: 5 },
        { key: 'chin', label: '托腮', count: 4 },
        { key: 'type', label: '打字', count: 4 },
      ],
      desk: [
        { key: 'window_top', label: '坐窗顶', count: 3, minutes: 40 },
        { key: 'edge', label: '屏幕边缘陪你', count: 2, minutes: 25 },
        { key: 'give_way', label: '给窗口让路', count: 4, minutes: null },
        { key: 'greet', label: '你离开后迎接', count: 2, minutes: null },
      ],
      tools: {
        enabled: on.agent,
        by_name: on.agent
          ? [
              { key: 'shell', label: '运行命令', count: 42 },
              { key: 'read', label: '读文件', count: 31 },
              { key: 'edit', label: '改文件', count: 12 },
              { key: 'browser', label: '浏览网页', count: 6 },
              { key: 'mcp', label: 'MCP 工具', count: 4 },
            ]
          : [],
        files_changed: on.agent ? 19 : 0,
        run_minutes: on.agent ? 72 : 0,
        asked: on.agent ? 3 : 0,
      },
      mood: Array.from({ length: Math.floor((today ? nowHour : 24) * 4) + 1 }, (_, q) => {
        const t = q / 4;
        return [day0 + t * 3600, +(0.55 + 0.25 * Math.sin((t - 9) / 4)).toFixed(3), +(0.2 + 0.15 * Math.sin((t - 6) / 5)).toFixed(3)];
      }),
      on_desk_min: 448,
    },
  };
}

export const routes: MockRoute[] = [
  {
    method: 'GET',
    path: '/brief/day',
    handler: ({ query }) => {
      const date = query.get('date') ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { status: 400, body: { error: 'invalid_date' } };
      const sw = query.get('sw') ?? new URLSearchParams((globalThis.location?.hash ?? '').split('?')[1] ?? '').get('sw');
      const on = Object.fromEntries(SWITCHES.map((s) => [s, sw == null || sw.split(',').includes(s)])) as Record<BriefSwitch, boolean>;
      return { status: 200, body: build(date, on) };
    },
  },
];
