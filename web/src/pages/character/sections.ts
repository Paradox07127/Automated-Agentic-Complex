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
  rows: readonly string[];
}

export const CHAR_SECTIONS: readonly CharSection[] = [
  { tab: 'behavior', id: 'behavior/move', title: '活动', rows: ['beh.stay', 'beh.range', 'beh.sit', 'beh.lean', 'beh.inertia', 'beh.physics', 'beh.watch'] },
  { tab: 'behavior', id: 'behavior/touch', title: '触碰与注视', rows: ['avatar_click', 'beh.touch', 'beh.pat', 'beh.pinch', 'beh.greet', 'beh.mouse'] },
  { tab: 'behavior', id: 'behavior/state', title: '状态与表情', rows: ['beh.mood', 'beh.face'] },
  { tab: 'behavior', id: 'behavior/overlay', title: '桌面浮层', rows: ['beh.rail', 'beh.hint'] },
  { tab: 'render', id: 'render/camera', title: '镜头', rows: ['rnd.cam', 'rnd.yaw', 'rnd.pitch', 'rnd.zoom', 'rnd.sway', 'rnd.closeup', 'rnd.track'] },
  { tab: 'render', id: 'render/light', title: '主光与轮廓', rows: ['rnd.lightYaw', 'rnd.lightPitch', 'rnd.lightStrength', 'rnd.outline'] },
  { tab: 'render', id: 'render/ground', title: '落地与环境', rows: ['rnd.ground', 'rnd.ambient', 'rnd.wrap'] },
  { tab: 'render', id: 'render/dof', title: '景深与滤镜', rows: ['rnd.dof', 'rnd.filter'] },
  { tab: 'render', id: 'render/perf', title: '性能', rows: ['rnd.fps', 'rnd.idle', 'rnd.batt', 'rnd.aa', 'rnd.size', 'rnd.shadow'] },
  { tab: 'scene', id: 'scene/scene', title: '场景', rows: ['scn.mode', 'scn.parallax'] },
];

/** Shown only in developer mode. */
export const DEV_ONLY_ROWS: ReadonlySet<string> = new Set(['rnd.aa', 'rnd.size', 'rnd.shadow']);

export const ROW_DESC: Readonly<Record<string, string>> = {
  'beh.sit': '坐在窗口顶沿',
  'beh.lean': '靠近窗沿时扶住',
  'beh.mouse': '视线跟随指针',
  'beh.inertia': '松开后短距离滑行',
  'beh.mood': '精神偏低时走速降低',
  avatar_click: '角色互动：摸头、问候等；打开快速输入：点她就能打字',
  'rnd.filter': '复刻游戏拍照模式的滤镜，只改她的颜色、不改桌面；黑金、温暖、苍白只复刻调色部分',
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
