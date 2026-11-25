// Words for the backend keys this page shows.
import { CAUSE_LABELS } from './tables';

/** character_state.py BECAUSE keys plus the causes of her own behaviors. */
export const CAUSES: Record<string, string> = {
  ...CAUSE_LABELS,
  short_walk: '走了一段',
  climb_window_top: '爬上了窗口顶',
  line: '说了一句',
};

/** Short cause names for marks on the state curve, where the label runs right of the line. */
export const CAUSE_SHORT: Record<string, string> = {
  session_done: '会话完成',
  dispatch_done: '任务完成',
  dispatch_failed: '派发失败',
  task_verified: '检查通过',
  task_failed: '任务出错',
  session_error: '会话出错',
  user_spoke: '对话',
  feedback_useful: '反馈有用',
  blocked: '受阻',
  short_walk: '走动',
  climb_window_top: '爬上窗顶',
  line: '发言',
};

/** character_state.py DOING: the raw activity key in words. */
const DOING: Record<string, string> = {
  sit: '坐着',
  observe: '看着窗口',
  idle: '待着',
  short_walk: '走动',
  hold_window_edge: '扶着窗边',
  climb_window_top: '待在窗顶',
  relax: '放松',
  think: '想事情',
  wait: '等着',
  sleep: '睡觉',
};

export const doing = (key: string | null): string | null => (key == null ? null : (DOING[key] ?? key));

/** character_state.py `_labels()` codes in words, per attribute. */
const STATE_WORDS: Record<'energy' | 'mood' | 'engagement', Record<string, string>> = {
  energy: { lively: '很好', okay: '还行', sleepy: '有点困', very_sleepy: '很困' },
  mood: { good: '不错', low: '有点低落', steady: '平稳' },
  engagement: { absorbed: '很投入', some: '一般', idle: '空闲' },
};

export const stateWord = (attr: keyof typeof STATE_WORDS, code: string): string => STATE_WORDS[attr][code] ?? code;

/** Action section names and notes. */
export const SECTIONS: Record<string, { name: string; note: string }> = {
  talk: { name: '说话', note: '说话时随机挑' },
  react: { name: '反应', note: '事件触发' },
  idle: { name: '待机', note: '没事做时轮换' },
  move: { name: '移动与姿态', note: '全屏层里走动' },
  touch: { name: '互动', note: '鼠标操作' },
  battle: { name: '攻击', note: '待机时偶尔拔武器出招' },
};

/** behavior.ticked `chosen` (behavior.py ACTIVITIES). */
export const BEHAVIOR: Record<string, string> = {
  idle: '待机',
  relax: '放松',
  fidget: '小动作',
  think: '思考',
  wait: '等待',
  react: '反应',
  yawn: '打哈欠',
  sleep: '睡着',
  fly: '空中施术',
  guard: '戒备',
};

/** Who settled a behavior tick, in lane order. */
export const BEAT_SOURCE = { model: '模型', rules: '规则', hard: '硬规则' } as const;

/** Said for a host code this page has no words for. */
export const NO_REASON = '桌面角色没有给出原因';

/** CharacterSwitch failure reasons: the shell's own codes and agentd's switch errors. */
const SWITCH_REASON: Record<string, string> = {
  superseded: '被后来的切换取代',
  not_connected: '桌面角色没有连上',
  connection_lost: '和桌面角色的连接断了',
  timeout: '桌面角色没有及时回应',
  switching: '另一次切换还在进行',
  unknown_character: '后台不认识这个角色',
  same_character: '已经是这个角色',
  character_changed: '角色刚被换过',
  unknown_switch: '后台找不到这次切换',
  wrong_character: '桌面上载入的是别的角色',
  load_failed: '角色加载失败',
  pack_rejected: '角色资源包没有通过校验',
  no_state: '后台还没准备好',
  outbound_blocked: '新角色的设定没有通过后台的出站检查',
  commit_failed: '后台没能换上这个角色',
};

/** A host reason in words: a known code, the host's own Chinese text, else NO_REASON (never an English detail). */
export const hostReason = (reason: string | undefined): string =>
  reason == null ? NO_REASON : (SWITCH_REASON[reason] ?? (/[\u4e00-\u9fff]/.test(reason) ? reason : NO_REASON));

/** motion_tool's reason codes for a VMD it did not import. */
const MOTION_IMPORT_REASON: Record<string, string> = {
  too_many_actions: '动作已满 128 条',
  too_many_media: '动作媒体已满 128 条',
  bad_vmd: '读不了这个 VMD 文件',
  too_long: '动作超过 360 秒',
  missing_bones: '这个角色的骨骼接不上 MMD 动作',
  busy: '正在切换角色或另一个导入还没完成，稍后再试',
  validate_failed: '桌面角色校验没有通过',
  unsupported_format: '不支持这种文件',
  bad_source: '文件读不出来',
  no_animation: '文件里没有动作',
  unmapped_skeleton: '骨架认不出人形骨',
  already_imported: '这个动作已经导入过',
  unknown_action: '找不到这个动作',
  not_imported: '这不是导入的动作',
  bad_title: '名字要 1–64 个字',
  linked_motion: '别的动作会接到这个动作，或别的动作行用到了它，所以不能删',
  outside_package: '角色包指向了包外的文件，为安全起见没有改',
  bad_zip: '压缩包打不开或不安全',
  scan_gone: '识别结果已失效，请重新导入',
};

/** motion_tool mmd-scan's reasons for a file of the project it left out. */
export const MMD_IGNORED_REASON: Record<string, string> = {
  not_motion: '不是动作或音频',
  no_keys: '没有关键帧',
  bad_vmd: '读不了',
};

/** A motion import failure in words; `internal` shows motion_tool's detail, the only place it says the cause. */
export const motionImportReason = (reason: string, detail: string | undefined): string =>
  MOTION_IMPORT_REASON[reason] ?? (reason === 'internal' && detail ? detail : hostReason(reason));

/** outfit_tool's reason codes (IMPORT_REASONS and its own) for an EFMI mod it did not import or an appearance it did not remove. */
export const OUTFIT_IMPORT_REASON: Record<string, string> = {
  unsupported_mod: '读不懂这个模组，它可能不是 EFMI 模组，或用了本程序还不支持的写法；可以换一个模组，或等更新',
  merged_skeleton: '这个模组用了合并骨架的写法，本程序还不支持；可以换一个模组，或等更新',
  unsafe_path: '模组里有指向模组目录之外的文件，为安全起见没有导入；请换一个来源可靠的模组',
  unmapped_component: '模组里有部件对不上这个角色的模型，可能是给别的角色做的；请确认角色，或换一个模组',
  bone_out_of_range: '模组用到的骨骼超出这个角色的骨架，可能是给别的角色做的；请确认角色，或换一个模组',
  missing_channel: '模组缺少这个角色的模型需要的数据，文件可能不完整；请重新下载，或换一个模组',
  texture_mismatch: '认不出模组的贴图该套在哪个部件上；可以换一个模组，或等更新',
  nothing_to_import: '模组没有给这个角色换上任何贴图或模型，导入了也看不出变化；请换一个模组',
  not_this_character: '这个模组不是给这个角色做的；请切到对应的角色再导入，或换一个模组',
  unsupported_texture_format: '模组里有贴图用的是本程序还不支持的格式；可以换一个模组，或等更新',
  unsupported_geometry: '模组改模型的写法本程序还不支持；可以换一个模组，或等更新',
  geometry_invalid: '模组的模型文件损坏或前后对不上；请重新下载，或换一个模组',
  channel_unresolved: '本程序补不全这个模组的模型数据；可以换一个模组，或等更新',
  geometry_too_large: '模组的模型太大，超过本程序能导入的上限；请换一个精简些的模组',
  ambiguous_ini: '模组目录里有多个 .ini 都像入口，分不出用哪个；请只留下要用的那个 .ini 再导入',
  absent_template_mesh: '模组要替换的模型在这个角色身上找不到；请确认角色，或换一个模组',
  absent_template_submesh: '模组要替换的部分在这个角色的模型里找不到；请确认角色，或换一个模组',
  index_format: '模组的模型数据格式本程序还不支持；可以换一个模组，或等更新',
  unknown_bone: '模组用到了这个角色没有的骨骼，可能是给别的角色做的；请确认角色，或换一个模组',
  duplicate_bone: '模组新加的骨骼和角色已有的骨骼重了，本程序还处理不了；可以换一个模组，或等更新',
  duplicate_submesh: '模组有两处替换同一块模型，分不出用哪个；可以换一个模组，或等更新',
  graph_store_missing: '本程序的导入组件不完整；请重新安装，或等更新',
  skin_matrices_layout: '这个角色的骨骼数据本程序还接不上模组的模型；可以等更新',
  channel_size: '模组的模型数据长短对不上，文件可能已损坏；请重新下载，或换一个模组',
  texture_size: '模组的贴图文件大小不对，可能已损坏；请重新下载，或换一个模组',
  buffer_size: '模组的模型文件大小不对，可能已损坏；请重新下载，或换一个模组',
  mod_too_large: '模组文件太大，超过本程序能导入的上限；请换一个小一些的模组',
  duplicate_appearance: '这个模组已经导入过，外观里已经有它',
  invalid_mapping: '指定的部件对照文件读不了；请检查这份文件，或不带它再导入',
  invalid_slot_hints: '本程序自带的贴图对照表损坏；请重新安装，或等更新',
  invalid_lod1_bones: '本程序自带的骨骼对照表损坏；请重新安装，或等更新',
  invalid_mod_settings: '模组的开关整理出的设置表没有通过检查，角色没有改动；可以换一个模组，或等更新',
  busy: '另一个外观导入还没完成，稍后再试',
  validate_failed: '导入结果没有通过桌面角色的校验，角色没有改动；可以换一个模组，或等更新',
  not_imported: '这不是导入的外观',
};

/** Said for an outfit_tool code this page has no words for. */
export const OUTFIT_IMPORT_UNKNOWN = '导入器给出了这个版本还不认识的原因；可以换一个模组，或等更新';

/** Codes whose detail names the mod's file or section after the code: `n` is that name. */
const OUTFIT_IMPORT_NAMED: Record<string, (n: string) => string> = {
  unmapped_component: (n) => `模组里的「${n}」对不上这个角色的模型，可能是给别的角色做的；请确认角色，或换一个模组`,
  texture_mismatch: (n) => `认不出模组的贴图「${n}」该套在哪个部件上；可以换一个模组，或等更新`,
};

/** `unsupported_geometry:<kind>:<name>` and `geometry_invalid:<kind>:<name>` by kind; `n` is the mod's section or resource. */
const OUTFIT_GEOMETRY: Record<string, (n: string) => string> = {
  custom_shader_output: (n) => `模组的「${n}」用自己的着色器生成模型，本程序还不支持；可以换一个模组，或等更新`,
  shapekey_default: () => '模组默认打开了形态键，本程序还不支持；可以换一个模组，或等更新',
  stream_only: (n) => `模组的「${n}」只换了模型的一部分数据，本程序还不支持；可以换一个模组，或等更新`,
  buffer_layout: (n) => `模组的「${n}」模型数据排布本程序还不认识；可以换一个模组，或等更新`,
  no_draw: (n) => `模组的「${n}」默认不画出模型，本程序还不支持；可以换一个模组，或等更新`,
  submesh: (n) => `认不出模组的「${n}」要替换角色模型的哪一部分；可以换一个模组，或等更新`,
  bone_unresolved: () => '模组用到的骨骼对不上这个角色的骨架，可能是给别的角色做的；请确认角色，或换一个模组',
  unknown_bone: () => OUTFIT_IMPORT_REASON.unknown_bone!,
  buffer_size: (n) => `模组的模型文件「${n}」大小不对，可能没下载完整；请重新下载，或换一个模组`,
  index_range: (n) => `模组的「${n}」模型数据超出范围，文件可能已损坏；请重新下载，或换一个模组`,
  stream_count: (n) => `模组的「${n}」几份模型数据长短不一，文件可能已损坏；请重新下载，或换一个模组`,
};

/** An outfit import failure in words. The detail holds `<reason>:<parts>` (the app puts the mod folder in front);
 * `internal` shows the detail itself, the only place it says the cause. */
export const outfitImportReason = (reason: string, detail: string | undefined): string => {
  const at = detail?.indexOf(`${reason}:`) ?? -1;
  const [first = '', second = ''] = at < 0 ? [] : detail!.slice(at + reason.length + 1).split(':').map((p) => p.trim());
  const geometry = reason === 'unsupported_geometry' || reason === 'geometry_invalid';
  const named = geometry ? OUTFIT_GEOMETRY[first] : OUTFIT_IMPORT_NAMED[reason];
  const name = geometry || reason === 'texture_mismatch' ? second : first;
  if (named && name) return named(name);
  if (reason === 'unsupported_mod' && first === 'nothing_to_import') return OUTFIT_IMPORT_REASON.nothing_to_import!;
  const own = OUTFIT_IMPORT_REASON[reason] ?? (reason === 'internal' && detail ? detail : hostReason(reason));
  return own === NO_REASON ? OUTFIT_IMPORT_UNKNOWN : own;
};

/** The import report's warnings by code (import_outfit, efmi_mod, efmi_geometry): `n` is the file, section or shader after the code. */
const OUTFIT_IMPORT_WARNING: Record<string, (n: string) => string> = {
  texture_unbound: (n) => `贴图「${n}」找不到该套的部件，没有用上`,
  texture_unsupported: (n) => `贴图「${n}」的格式本程序还不支持，没有用上`,
  external_namespace: (n) => `贴图「${n}」要借别的模组的部件才套得上，没有用上`,
  needs_mips: (n) => `贴图「${n}」没有缩小用的多级图，远看可能发虚`,
  format_tag: (n) => `贴图「${n}」文件名写的格式和实际的不同，已按实际格式用上`,
  geometry_not_applied: (n) => `模组的「${n}」改了模型，没有套上`,
  stale_hash: (n) => `模组的「${n}」写的是旧版游戏的部件，这里照样套上了，游戏里它不会生效`,
  stream_only_ignored: (n) => `模组的「${n}」只换了模型的一部分数据，没有套上`,
  shader_patch_ignored: (n) => {
    const [ini, ...files] = n.split(':');
    return `模组的「${ini}」改的是游戏的着色器，没有套上${files.length ? `，只给它用的贴图${files.map((f) => `「${f}」`).join('')}也没用上` : ''}`;
  },
  custom_shader_ignored: (n) => `模组的「${n}」用自己的着色器做的效果，没有套上`,
  shader_textures_ignored: (n) => `只给模组自己的着色器用的贴图${n.split(':').map((f) => `「${f}」`).join('')}没有用上`,
  shapekey_ignored: () => '模组的形态键没有套上',
  morph_ignored: () => '模组的变形效果没有套上',
  weights_renormalized: () => '模组模型的骨骼权重加起来不对，已按比例改过',
  zero_weights_fixed: () => '模组模型有些地方没有骨骼权重，已经补上',
  bones_appended: (n) => `模组给「${n.split(':')[0]}」新加了骨骼`,
  normals_recomputed: () => '模组模型的法线重新算过，光影可能和原来略有不同',
  outline_normals_recomputed: () => '模组模型的描边方向重新算过，描边可能和原来略有不同',
  color0_ignored: () => '模组模型的顶点颜色没有用上',
  setting_fixed: () => '这个开关在 mod 里写死了，不能切换',
  variant_unplaced: () => '有贴图变体找不到对应部件，没有导入',
  segment_unmappable: () => '有部件对不上角色模型，没有导入',
  eff_target_absent: (n) => `模组要换的「${n}」这个角色身上没有，没有套上`,
  eff_material_other: (n) => `模组的「${n}」用的是别的部件的材质，保留了原来的贴图`,
};

/** One import report warning (`<code>` or `<code>:<name>`) in words; a code this page does not know stays as it came. */
export const outfitImportWarning = (warning: string): string => {
  const at = warning.indexOf(':');
  const words = OUTFIT_IMPORT_WARNING[at < 0 ? warning : warning.slice(0, at)];
  return words ? words(at < 0 ? '' : warning.slice(at + 1)) : warning;
};

/** motion_tool's format code as written on screen. */
const MOTION_FORMAT: Record<string, string> = { vmd: 'VMD', bvh: 'BVH', gltf: 'glTF', vrma: 'VRMA', fbx: 'FBX' };

export const motionFormatLabel = (format: string): string => MOTION_FORMAT[format] ?? format.toUpperCase();

/** Why the host refused to play an action. */
export const PLAY_REFUSED: Record<string, string> = {
  not_playable: '这个动作不能单独播放',
  missing: '这个动作缺资源，播不了',
  unknown_action: '桌面上的角色没有这个动作',
  wrong_character: '桌面上不是这个角色',
  switching: '角色正在切换，切完再播',
  releasing: '角色正在切换，切完再播',
  busy: '角色暂时无法切换动作，稍后再播',
  not_ready: '角色的动作还在加载，稍后再播',
  not_implemented: '这个版本还不支持桌面预览',
};

/** Refusals that pass on their own: they warn rather than report an error. */
const PLAY_WAIT = new Set(['switching', 'releasing', 'busy', 'not_ready']);

export const playRefusedSeverity = (code: string): 'warning' | 'danger' => (PLAY_WAIT.has(code) ? 'warning' : 'danger');

/** Why the host changed a switch back after a save. */
export const ADJUSTED: Record<string, string> = {
  required: '必需动作',
  missing: '缺资源',
  last_in_section: '分区里至少留一个',
};
