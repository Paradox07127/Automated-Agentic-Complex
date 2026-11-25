// 每日简报的统计：GET /brief/day 一次读回一天；做完了、在做、提醒、观察日报等列表仍读各自原有的接口。
import { get } from '../../bridge/agentd';
import type { WireBriefError } from '../../domain/wire';

/** 决定简报显示哪些块的开关，各对应设置里的一行。 */
export type BriefSwitch = 'scr' | 'read' | 'shot' | 'code' | 'agent' | 'voice';

export type BriefItemId = 'done' | 'err' | 'turn' | 'line' | 'fg' | 'say' | 'motion' | 'touch' | 'voice' | 'mem' | 'cost' | 'code' | 'shot' | 'mask' | 'rem';

export interface BriefItem {
  /** false：它要的开关关着，这一天没有记录。 */
  enabled: boolean;
  /** 当天总数；fg 单位分钟，voice 单位秒，cost 单位美元，其余是次数。 */
  today: number;
  /** 0–23 点每小时的数，长 24；今天还没到的小时是 0；只按天记的项为 null。 */
  hours: number[] | null;
  /** 前 7 天（不含这一天）的日均；没有记录为 null。 */
  avg7: number | null;
  yesterday: number | null;
}

/** `at`：unix 秒。kind：self 她主动且你回了，miss 她主动你没回，reply 她回你。 */
export interface BriefLine {
  at: number;
  kind: 'self' | 'reply' | 'miss';
  text: string;
  /** 一行补充，如「你回了「加吧」」。 */
  note: string;
}

export interface BriefCount {
  key: string;
  label: string;
  count: number;
}

export interface BriefDay {
  /** 本地日期 YYYY-MM-DD。 */
  date: string;
  /** 这一天还没过完。 */
  partial: boolean;
  switches: Record<BriefSwitch, boolean>;
  items: Record<BriefItemId, BriefItem>;
  /** 时间页读数；enabled 跟 switches.scr。时间都是 unix 秒。 */
  focus: {
    enabled: boolean;
    away_min: number;
    longest: { start: number; minutes: number } | null;
    pauses: Array<[number, number]>;
    /** 前台分钟数按应用，降序，最多 6 个。 */
    apps: Array<{ name: string; minutes: number }>;
    /** 浏览器前台分钟数按域名，降序，最多 6 个；无痕窗口不记；switches.read 关着时为空。 */
    sites: Array<{ host: string; minutes: number }>;
  };
  her: {
    said: { total: number; self: number; replied: number };
    /** 最多 3 句：self、reply、miss 各一句，缺哪类就少一句。 */
    lines: BriefLine[];
    touch: { pat: number; pinch: number; drag: number; wheel: number };
    /** 她主动开口的原因，按次数降序。 */
    why: BriefCount[];
    /** 播放次数最多的 6 个动作。 */
    motions: BriefCount[];
    /** 桌面行为：坐窗顶、屏幕边缘陪你按分钟，让路、迎接按次数。 */
    desk: Array<BriefCount & { minutes: number | null }>;
    /** enabled 跟 switches.agent。 */
    tools: { enabled: boolean; by_name: BriefCount[]; files_changed: number; run_minutes: number; asked: number };
    /** [unix 秒, 精神, 心情]，取值同 /character/state/history，按时间升序。 */
    mood: Array<[number, number, number]>;
    /** 她在桌面上的分钟数；没有来源时为 null。 */
    on_desk_min: number | null;
  };
  /** items.err 计的每一条，按时刻升序。 */
  errors: WireBriefError[];
}

export interface ItemMeta {
  name: string;
  /** 名字下的一行说明。 */
  src: string;
  unit: string;
  kind?: 'min' | 'sec' | 'usd';
  /** 要其中任一个开关开着；空数组表示不需要开关。 */
  need: BriefSwitch[];
}

export const ITEMS: Record<BriefItemId, ItemMeta> = {
  done: { name: '已完成任务', src: '已完成任务与交付产物', unit: '', need: ['agent', 'code'] },
  err: { name: '异常', src: '任务与编码会话中的异常记录', unit: '', need: ['agent', 'code'] },
  turn: { name: '对话轮次', src: '与角色的对话往返轮数', unit: '轮', need: [] },
  line: { name: '角色发言', src: '回复、主动触发及交互回应的总句数', unit: '句', need: [] },
  fg: { name: '在电脑前', src: '前台使用时长（不含离开时段）', unit: '', kind: 'min', need: ['scr'] },
  say: { name: '主动发言', src: '角色主动发起交互的次数', unit: '次', need: [] },
  motion: { name: '动作播放', src: '角色在桌面上播放的动作次数', unit: '次', need: [] },
  touch: { name: '互动触碰', src: '摸头、脸颊交互、拖动与右键轮盘', unit: '次', need: [] },
  voice: { name: '语音播报', src: '语音合成播放总时长', unit: '', kind: 'sec', need: ['voice'] },
  mem: { name: '新增记忆', src: '写入记忆库的事实条目', unit: '条', need: [] },
  cost: { name: '模型用量费用', src: '对话、执行内核与记忆整理消耗', unit: '', kind: 'usd', need: [] },
  code: { name: '编码会话', src: 'Claude Code、Codex 会话数', unit: '个', need: ['code'] },
  shot: { name: '屏幕截图', src: '屏幕识读附带的截图数量', unit: '张', need: ['shot'] },
  mask: { name: '发送前脱敏', src: '发送给模型前已脱敏处理的字段数', unit: '处', need: ['scr', 'shot'] },
  rem: { name: '提醒事项', src: '已触发的提醒次数', unit: '个', need: [] },
};

export const ITEM_ORDER: BriefItemId[] = ['done', 'err', 'turn', 'line', 'fg', 'say', 'motion', 'touch', 'voice', 'mem', 'cost', 'code', 'shot', 'mask', 'rem'];

export const SWITCH_LABEL: Record<BriefSwitch, string> = {
  scr: '屏幕感知',
  read: '窗口文字与网页正文',
  shot: '屏幕识读附带截图',
  code: '读取编码会话',
  agent: '个人代理与自主能力',
  voice: '语音播报',
};

export const DEFAULT_PINS: BriefItemId[] = ['done', 'err', 'turn', 'fg', 'say', 'cost'];
/** 星标的项关着时，读数带按这个顺序补够 6 个；这些项都不要开关。 */
export const FILL: BriefItemId[] = ['turn', 'line', 'motion', 'touch', 'mem', 'say', 'rem', 'cost'];

/** 总览读数带的 6 项：星标里开着的，再按 FILL 补齐。 */
export function readouts(day: BriefDay, pins: BriefItemId[]): BriefItemId[] {
  const out = pins.filter((id) => day.items[id].enabled);
  for (const id of FILL) {
    if (out.length >= 6) break;
    if (!out.includes(id) && day.items[id].enabled) out.push(id);
  }
  return out.slice(0, 6);
}

export const readBriefDay = (date: string) => get<BriefDay>(`/brief/day?date=${date}`);
