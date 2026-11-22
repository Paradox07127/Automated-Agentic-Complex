// 行的位置表。加一行设置的完整步骤见 notes/design/app-depth-20261115/settings/DESIGN.md §5.1；不在 schema 里的 id 不显示；没排位的 @character 行按 id 前缀落到该页的「其他」。

export type CharTab = 'behavior' | 'render' | 'scene';

export const CHAR_TABS: ReadonlyArray<{ id: CharTab; title: string; en: string }> = [
  { id: 'behavior', title: '行为', en: 'Behavior' },
  { id: 'render', title: '画面', en: 'Render' },
  { id: 'scene', title: '场景', en: 'Scene' },
];

export interface CharSection {
  tab: CharTab;
  id: string;
  title: string;
  /** Decorative Latin beside the title. */
  en: string;
  rows: readonly string[];
  /** The live preview does not take these rows (they are not in supervisor.ts lookArguments): the head says 「仅桌面」. */
  desktopOnly?: true;
}

// 画面: the sections the preview follows first, then the desktop-only ones.
export const CHAR_SECTIONS: readonly CharSection[] = [
  { tab: 'behavior', id: 'behavior/move', title: '活动', en: 'Movement', rows: ['beh.stay', 'beh.range', 'beh.sit', 'beh.lean', 'beh.inertia', 'beh.physics', 'beh.watch'] },
  { tab: 'behavior', id: 'behavior/touch', title: '触碰与注视', en: 'Touch & Gaze', rows: ['avatar_click', 'beh.touch', 'beh.pat', 'beh.pinch', 'beh.greet', 'beh.mouse'] },
  { tab: 'behavior', id: 'behavior/state', title: '状态与表情', en: 'State & Face', rows: ['beh.mood', 'beh.face'] },
  { tab: 'behavior', id: 'behavior/overlay', title: '桌面浮层', en: 'Overlay', rows: ['beh.rail', 'beh.hint'] },
  { tab: 'render', id: 'render/light', title: '主光与轮廓', en: 'Key Light & Outline', rows: ['rnd.lightYaw', 'rnd.lightPitch', 'rnd.lightStrength', 'rnd.outline'] },
  { tab: 'render', id: 'render/ground', title: '落地与景深', en: 'Ground & Depth', rows: ['rnd.ground', 'rnd.dof'] },
  { tab: 'render', id: 'render/ambient', title: '环境光', en: 'Ambient', rows: ['rnd.ambient', 'rnd.wrap'], desktopOnly: true },
  // rnd.closeup is not a launch argument either: camera/closeup.ts pushes it to the desktop renderer only.
  { tab: 'render', id: 'render/camera', title: '镜头', en: 'Camera', rows: ['rnd.cam', 'rnd.yaw', 'rnd.pitch', 'rnd.zoom', 'rnd.sway', 'rnd.closeup', 'rnd.track'], desktopOnly: true },
  { tab: 'render', id: 'render/perf', title: '性能', en: 'Performance', rows: ['rnd.fps', 'rnd.idle', 'rnd.batt'], desktopOnly: true },
  { tab: 'scene', id: 'scene/scene', title: '场景', en: 'Scene', rows: ['scn.mode', 'scn.parallax'] },
];

/** @character rows that belong to 拍照, not to any 设定 page. */
export const PHOTO_ONLY_ROWS: ReadonlySet<string> = new Set(['rnd.filter']);

/** 主光方向: one 3×3 pad for these two rows. */
export const LIGHT_PAD = { yaw: 'rnd.lightYaw', pitch: 'rnd.lightPitch' } as const;

/** Rows drawn as segments with these short labels in place of the schema's. */
export const SEG_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'rnd.lightStrength': { '0.5': '50', '0.75': '75', '1': '100', '1.25': '125', '1.5': '150' },
};

/** Drawn on 调参 › 画面 (tune/Render.tsx), never on the character page. */
export const TUNE_ONLY_ROWS: ReadonlySet<string> = new Set(['rnd.aa', 'rnd.size', 'rnd.shadow']);

export const ROW_DESC: Readonly<Record<string, string>> = {
  'beh.sit': '坐在窗口顶沿',
  'beh.lean': '靠近窗沿时扶住',
  'beh.mouse': '视线跟随指针',
  'beh.inertia': '松开后短距离滑行',
  'beh.mood': '精神偏低时走速降低',
  avatar_click: '角色互动：摸头、问候等；打开快速输入：点她就能打字',
  'rnd.dof': '镜头处于近景时虚化她身上离焦的部分；全身景别下看不出',
};

export const OTHER_TITLE = '其他';

export function isCharTab(v: string | null | undefined): v is CharTab {
  return CHAR_TABS.some((t) => t.id === v);
}

export function placedTab(id: string): CharTab | null {
  return CHAR_SECTIONS.find((s) => s.rows.includes(id))?.tab ?? null;
}

export function tabOf(id: string): CharTab {
  return placedTab(id) ?? (id.startsWith('rnd.') ? 'render' : id.startsWith('scn.') ? 'scene' : 'behavior');
}
