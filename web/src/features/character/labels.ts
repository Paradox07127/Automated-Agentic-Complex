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
  sit: '坐姿待机',
  observe: '观察屏幕',
  idle: '待机',
  short_walk: '短距离移动',
  hold_window_edge: '扶靠窗沿',
  climb_window_top: '倚坐窗顶',
  relax: '放松',
  think: '思考中',
  wait: '等待中',
  sleep: '休眠',
};

export const doing = (key: string | null): string | null => (key == null ? null : (DOING[key] ?? key));

/** character_state.py `_labels()` codes in words, per attribute. */
const STATE_WORDS: Record<'energy' | 'mood' | 'engagement', Record<string, string>> = {
  energy: { lively: '充沛', okay: '正常', sleepy: '疲倦', very_sleepy: '极疲倦' },
  mood: { good: '良好', low: '低落', steady: '平稳' },
  engagement: { absorbed: '专注', some: '一般', idle: '空闲' },
};

export const stateWord = (attr: keyof typeof STATE_WORDS, code: string): string => STATE_WORDS[attr][code] ?? code;

/** Action section names and notes. */
export const SECTIONS: Record<string, { name: string; note: string }> = {
  talk: { name: '对话', note: '语音或对话期间随机触发' },
  react: { name: '反应', note: '由事件触发' },
  idle: { name: '待机', note: '空闲时轮换播放' },
  move: { name: '移动与姿态', note: '在全屏层移动' },
  touch: { name: '互动', note: '光标交互触发' },
  battle: { name: '动作展示', note: '待机时偶发展示动作' },
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
export const NO_REASON = '角色渲染进程未返回原因';

/** CharacterSwitch failure reasons: the shell's own codes and agentd's switch errors. */
const SWITCH_REASON: Record<string, string> = {
  superseded: '已被后续切换请求替代',
  not_connected: '角色渲染进程未连接',
  connection_lost: '与角色渲染进程的连接中断',
  timeout: '角色渲染进程响应超时',
  switching: '另一项角色切换仍在进行中',
  unknown_character: '后台服务未找到该角色',
  same_character: '当前已是该角色',
  character_changed: '角色状态已变更',
  unknown_switch: '后台服务未找到该切换记录',
  wrong_character: '桌面当前加载的是其他角色',
  load_failed: '角色资源加载失败',
  pack_rejected: '角色资源包未通过校验',
  no_state: '后台服务尚未就绪',
  commit_failed: '后台服务未能完成角色切换',
};

/** A host reason in words: a known code, the host's own Chinese text, else NO_REASON (never an English detail). */
export const hostReason = (reason: string | undefined): string =>
  reason == null ? NO_REASON : (SWITCH_REASON[reason] ?? (/[\u4e00-\u9fff]/.test(reason) ? reason : NO_REASON));

/** motion_tool's reason codes for a VMD it did not import. */
const MOTION_IMPORT_REASON: Record<string, string> = {
  too_many_actions: '动作数量已达上限（128 条）',
  too_many_media: '动作配套媒体已达上限（128 条）',
  bad_vmd: '无法读取该 VMD 文件',
  too_long: '动作时长超过 360 秒上限',
  missing_bones: '当前角色骨骼与该 MMD 动作不兼容',
  busy: '正在切换角色或有其他导入任务进行中，请稍后重试',
  validate_failed: '角色渲染进程校验未通过',
  unsupported_format: '不支持该文件格式',
  bad_source: '无法读取源文件',
  no_animation: '文件中未包含有效动作数据',
  unmapped_skeleton: '无法识别标准人形骨骼映射',
  already_imported: '该动作已导入',
  unknown_action: '未找到该动作',
  not_imported: '该动作并非用户导入项',
  bad_title: '名称须为 1–64 个字符',
  linked_motion: '存在关联的动作衔接或其他动作行引用，无法删除',
  outside_package: '角色包包含指向包外的路径，出于安全限制未予修改',
  bad_zip: '压缩包无法读取或存在路径安全风险',
  scan_gone: '识别结果已失效，请重新导入',
};

/** motion_tool mmd-scan's reasons for a file of the project it left out. */
export const MMD_IGNORED_REASON: Record<string, string> = {
  not_motion: '非动作或音频文件',
  no_keys: '无有效关键帧',
  bad_vmd: '无法读取该文件',
};

/** A motion import failure in words; `internal` shows motion_tool's detail, the only place it says the cause. */
export const motionImportReason = (reason: string, detail: string | undefined): string =>
  MOTION_IMPORT_REASON[reason] ?? (reason === 'internal' && detail ? detail : hostReason(reason));

/** outfit_tool's reason codes (IMPORT_REASONS and its own) for an EFMI mod it did not import or an appearance it did not remove. */
export const OUTFIT_IMPORT_REASON: Record<string, string> = {
  unsupported_mod: '无法识别此模组：可能并非 EFMI 模组，或使用了当前版本尚不支持的格式；请更换模组或等待后续版本支持',
  merged_skeleton: '此模组使用了合并骨架格式，当前版本暂不支持；请更换模组或等待后续版本支持',
  unsafe_path: '模组包含指向模组目录之外的路径，出于安全限制未导入；请更换来源可靠的模组',
  unmapped_component: '模组存在无法匹配当前角色模型的部件，可能适用于其他角色；请确认目标角色或更换模组',
  bone_out_of_range: '模组引用的骨骼超出当前角色骨架范围，可能适用于其他角色；请确认目标角色或更换模组',
  missing_channel: '模组缺少当前角色模型所需的数据通道，文件可能不完整；请重新下载或更换模组',
  texture_mismatch: '无法识别模组贴图对应的模型部件；请更换模组或等待后续版本支持',
  nothing_to_import: '该模组未对当前角色应用任何贴图或模型变更，导入后无视觉变化；请更换模组',
  not_this_character: '该模组不适用于当前角色；请切换至对应角色后再导入，或更换模组',
  unsupported_texture_format: '模组包含当前版本暂不支持的贴图格式；请更换模组或等待后续版本支持',
  unsupported_geometry: '模组使用的模型修改方式当前版本暂不支持；请更换模组或等待后续版本支持',
  geometry_invalid: '模组模型文件已损坏或数据不一致；请重新下载或更换模组',
  channel_unresolved: '当前版本无法补全此模组的模型数据；请更换模组或等待后续版本支持',
  geometry_too_large: '模组模型体积超出导入上限；请更换更精简的模组',
  ambiguous_ini: '模组目录中存在多个入口 .ini 文件，无法确定使用哪一个；请仅保留目标 .ini 文件后重试',
  absent_template_mesh: '当前角色模型中不存在该模组试图替换的网格；请确认目标角色或更换模组',
  absent_template_submesh: '当前角色模型中不存在该模组试图替换的子网格部分；请确认目标角色或更换模组',
  index_format: '模组模型索引数据格式当前版本暂不支持；请更换模组或等待后续版本支持',
  unknown_bone: '模组引用了当前角色不存在的骨骼，可能适用于其他角色；请确认目标角色或更换模组',
  duplicate_bone: '模组新增的骨骼与角色现有骨骼重名，当前版本暂不支持处理；请更换模组或等待后续版本支持',
  duplicate_submesh: '模组存在两处配置替换同一模型区块，无法确定优先级；请更换模组或等待后续版本支持',
  graph_store_missing: '当前应用的导入组件不完整；请重新安装应用或等待版本更新',
  skin_matrices_layout: '当前角色骨骼数据布局与该模组模型暂不兼容；请等待后续版本支持',
  channel_size: '模组模型数据长度与预期不符，文件可能已损坏；请重新下载或更换模组',
  texture_size: '模组贴图文件大小异常，文件可能已损坏；请重新下载或更换模组',
  buffer_size: '模组模型缓冲区文件大小异常，文件可能已损坏；请重新下载或更换模组',
  mod_too_large: '模组文件体积超出导入上限；请更换体积较小的模组',
  duplicate_appearance: '该模组已导入，外观列表中已存在此项目',
  invalid_mapping: '指定的部件映射文件无法读取；请检查该文件或取消指定后重新导入',
  invalid_slot_hints: '内置贴图槽位映射表已损坏；请重新安装应用或等待版本更新',
  invalid_lod1_bones: '内置骨骼映射表已损坏；请重新安装应用或等待版本更新',
  invalid_mod_settings: '模组开关生成的配置表未通过校验，未对角色做出更改；请更换模组或等待后续版本支持',
  busy: '另一项外观导入尚未完成，请稍后再试',
  validate_failed: '导入结果未通过角色渲染进程校验，未对角色做出更改；请更换模组或等待后续版本支持',
  not_imported: '该外观并非用户导入项',
};

/** Said for an outfit_tool code this page has no words for. */
export const OUTFIT_IMPORT_UNKNOWN = '导入器返回了当前版本尚未适配的错误代码；请更换模组或等待后续版本支持';

/** Codes whose detail names the mod's file or section after the code: `n` is that name. */
const OUTFIT_IMPORT_NAMED: Record<string, (n: string) => string> = {
  unmapped_component: (n) => `模组中的「${n}」无法匹配当前角色模型，可能适用于其他角色；请确认目标角色或更换模组`,
  texture_mismatch: (n) => `无法识别模组贴图「${n}」对应的模型部件；请更换模组或等待后续版本支持`,
};

/** `unsupported_geometry:<kind>:<name>` and `geometry_invalid:<kind>:<name>` by kind; `n` is the mod's section or resource. */
const OUTFIT_GEOMETRY: Record<string, (n: string) => string> = {
  custom_shader_output: (n) => `模组中的「${n}」使用自定义着色器生成模型，当前版本暂不支持；请更换模组或等待后续版本支持`,
  shapekey_default: () => '模组默认启用了形态键，当前版本暂不支持；请更换模组或等待后续版本支持',
  stream_only: (n) => `模组中的「${n}」仅修改了部分模型数据流，当前版本暂不支持；请更换模组或等待后续版本支持`,
  buffer_layout: (n) => `模组中的「${n}」模型数据排布格式暂未适配；请更换模组或等待后续版本支持`,
  no_draw: (n) => `模组中的「${n}」默认不绘制模型，当前版本暂不支持；请更换模组或等待后续版本支持`,
  submesh: (n) => `无法识别模组中的「${n}」应替换当前角色模型的哪一部分；请更换模组或等待后续版本支持`,
  bone_unresolved: () => '模组引用的骨骼无法匹配当前角色骨架，可能适用于其他角色；请确认目标角色或更换模组',
  unknown_bone: () => OUTFIT_IMPORT_REASON.unknown_bone!,
  buffer_size: (n) => `模组模型文件「${n}」大小异常，文件可能未下载完整；请重新下载或更换模组`,
  index_range: (n) => `模组中的「${n}」模型索引超出范围，文件可能已损坏；请重新下载或更换模组`,
  stream_count: (n) => `模组中的「${n}」多项模型数据长度不一致，文件可能已损坏；请重新下载或更换模组`,
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
  texture_unbound: (n) => `贴图「${n}」未找到对应部件，未应用`,
  texture_guessed: (n) => {
    const [file, slot] = n.split('->');
    return `贴图「${file}」未标注槽位，已按格式放入「${slot}」，请确认显示效果`;
  },
  texture_unsupported: (n) => `贴图「${n}」格式暂不支持，未应用`,
  external_namespace: (n) => `贴图「${n}」依赖其他模组部件，无法匹配，未应用`,
  needs_mips: (n) => `贴图「${n}」缺少多级渐远纹理（Mipmaps），远景显示可能较模糊`,
  format_tag: (n) => `贴图「${n}」文件名标注格式与实际不符，已按实际格式加载`,
  geometry_not_applied: (n) => `模组对「${n}」的模型修改未应用`,
  stale_hash: (n) => `模组中的「${n}」指向旧版部件标识，此处仍已应用，但在原游戏中不会生效`,
  stream_only_ignored: (n) => `模组中的「${n}」仅修改了部分模型数据流，未应用`,
  shader_patch_ignored: (n) => {
    const [ini, ...files] = n.split(':');
    return `模组中的「${ini}」修改了游戏着色器，未应用${files.length ? `；其专用贴图${files.map((f) => `「${f}」`).join('')}亦未应用` : ''}`;
  },
  custom_shader_ignored: (n) => `模组中的「${n}」使用的自定义着色器效果未应用`,
  shader_textures_ignored: (n) => `仅用于模组自定义着色器的贴图${n.split(':').map((f) => `「${f}」`).join('')}未应用`,
  shapekey_ignored: () => '模组的形态键未应用',
  morph_ignored: () => '模组的变形效果未应用',
  weights_renormalized: () => '模组模型骨骼权重之和异常，已自动按比例归一化',
  zero_weights_fixed: () => '模组模型部分顶点缺少骨骼权重，已自动补全',
  bones_appended: (n) => `模组为「${n.split(':')[0]}」追加了骨骼`,
  normals_recomputed: () => '模组模型法线已重新计算，光影效果可能与原模组略有差异',
  outline_normals_recomputed: () => '模组模型描边法线已重新计算，描边效果可能与原模组略有差异',
  color0_ignored: () => '模组模型的顶点颜色未应用',
  setting_fixed: () => '该开关已在模组中固定，不支持切换',
  variant_unplaced: () => '部分贴图变体未找到对应部件，未导入',
  segment_unmappable: () => '部分部件无法匹配当前角色模型，未导入',
  eff_target_absent: (n) => `当前角色不存在模组需替换的目标「${n}」，未应用`,
  eff_material_other: (n) => `模组中的「${n}」引用了其他部件的材质，已保留原贴图`,
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
  not_playable: '此动作不支持单独播放',
  missing: '此动作缺少所需资源，无法播放',
  unknown_action: '当前角色不包含此动作',
  wrong_character: '当前加载的角色与该动作不匹配',
  switching: '角色切换进行中，完成后可播放',
  releasing: '角色切换进行中，完成后可播放',
  busy: '角色当前无法切换动作，请稍后再试',
  not_ready: '角色动作资源仍在加载中，请稍后再试',
  not_implemented: '当前版本暂不支持实时预览',
};

/** Refusals that pass on their own: they warn rather than report an error. */
const PLAY_WAIT = new Set(['switching', 'releasing', 'busy', 'not_ready']);

export const playRefusedSeverity = (code: string): 'warning' | 'danger' => (PLAY_WAIT.has(code) ? 'warning' : 'danger');

/** Why the host changed a switch back after a save. */
export const ADJUSTED: Record<string, string> = {
  required: '核心必需动作',
  missing: '缺少资源',
  last_in_section: '分区内至少保留一项',
};
