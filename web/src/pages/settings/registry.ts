import { useCallback } from 'react';
import { ROUTES, routeIds } from './fields';
import { SETTING_GROUPS } from './groups';
import type { Capabilities } from '../../bridge';
import { PLUGINS } from '../../bridge/plugins.generated';
import { useDevMode } from '../../shell/devMode';
import { usePlugins, type PluginId, type PluginState } from '../../shell/plugins';
import type { IconName } from '../../ui';

export type GroupId = 'speak' | 'perm' | 'privacy' | 'kernel' | 'model' | 'keys' | 'data' | 'about';

// 能做 and 观察 keep the ids 'perm' and 'privacy' that other pages and agentd actions link to.
export const GROUP_IDS: GroupId[] = ['speak', 'perm', 'privacy', 'kernel', 'model', 'keys', 'data', 'about'];

export const DEFAULT_GROUP: GroupId = 'speak';

export const GROUP_ICON: Record<GroupId, IconName> = {
  speak: 'voice',
  perm: 'tool',
  privacy: 'eye',
  kernel: 'kernel',
  model: 'hub',
  keys: 'keys',
  data: 'data',
  about: 'info',
};

export const GROUP_LABEL: Record<string, string> = Object.fromEntries(SETTING_GROUPS.map((g) => [g.id, g.label]));

/** Rows that exist only while the kernel is Pi; search leaves them out for other kernels. */
export const PI_ONLY_ROWS: ReadonlySet<string> = new Set(['runsrc', 'piApproval', 'piTools', 'maxCost']);

/** Groups whose values all come from agentd; they turn read-only when the backend is down. */
export const NEEDS_AGENTD: GroupId[] = ['kernel', 'model'];

/** Groups holding config.json rows; they turn read-only when the shell cannot read it. */
export const NATIVE_GROUPS: GroupId[] = ['speak', 'perm', 'privacy', 'keys', 'about'];

export function isGroup(v: string | null | undefined): v is GroupId {
  return GROUP_IDS.includes(v as GroupId);
}

/** Rows edited as a draft and applied per section. */
export const DRAFT_SECTION: Record<string, string> = {
  kernel: 'kernel', runsrc: 'kernel', exe: 'kernel', workspace: 'kernel', acpAgent: 'kernel', acpLauncher: 'kernel', acct: 'kernel', provider: 'kernel', mainModel: 'kernel',
  ...Object.fromEntries(ROUTES.flatMap((p) => Object.values(routeIds(p)).map((id) => [id, 'kernel']))),
  maxCost: 'kernel', piApproval: 'kernel',
  svc: 'm_acct', piProvider: 'm_acct', apiBase: 'm_acct', chatModel: 'm_chat', think: 'm_chat',
};

/** Which group a draft section belongs to (the tab's draft mark). */
export const SECTION_GROUP: Record<string, GroupId> = { kernel: 'kernel', m_acct: 'model', m_chat: 'model' };

/** What a destructive switch removes, for the confirm text. */
export const DELETE_WHAT: Record<string, string> = {
  wintext: '窗口文字',
  web: '网页正文摘要，以及由它推出的记忆',
  typing: '输入记录',
  agent_sessions: '编码会话内容',
};

export type SettingEffect = 'instant' | 'restartBackend' | 'restartAvatar' | 'groupApply' | 'action';

/** Pages a search result can live on besides this one. */
export type ElsewhereGroup = '@character' | '@memory' | '@overview';

/** One searchable setting. Groups starting with `@` live on another page. Restart marks come from the native schema. */
export interface RegEntry {
  id: string;
  group: GroupId | ElsewhereGroup;
  section: string;
  label: string;
  keywords: string;
  effect: SettingEffect;
  deletesData: boolean;
  /** Shown and found only while this plug-in is on. */
  plugin?: PluginId;
  /** Shown and found only in 开发者模式. */
  dev?: true;
}

type Raw = [id: string, group: RegEntry['group'], section: string, label: string, keywords?: string, action?: boolean];

const RAW: Raw[] = [
  ['mute', 'speak', '声音', '出声', '静音 只显示文字 念出来 语音'],
  ['tts', 'speak', '声音', '语音服务', 'tts 远端 外部 地址 令牌 测试 连不上 重新连接'],
  ['ttsUrl', 'speak', '声音', '服务地址', 'tts 外部 地址 https'],
  ['ttsTunnelHost', 'speak', '声音', 'SSH 转发主机', 'tts ssh 隧道 转发 主机'],
  ['ttsEnsureScript', 'speak', '声音', '按需启动脚本', 'tts ssh 脚本 按需 启动'],
  ['asr', 'speak', '声音', '听写语言', '语音识别 识别语言 中文 英文 English 按住说话'],
  ['replyLang', 'speak', '声音', '回复语言', '回答 语言 中文 英文 日文 English 日本語 reply_language 内核'],
  ['speakWhen', 'speak', '主动开口', '她会不会主动找你', '主动发言 主动开口 主动提示 只在我问时 想法'],
  ['proactive', 'speak', '主动开口', '多主动', '主动程度 交互档位 频率'],
  ['quiet_hours', 'speak', '主动开口', '免打扰时段', '勿扰 夜间 时段'],
  ['mutes', 'speak', '主动开口', '已关掉的主动发言', '关闭此类 恢复'],
  ['rest', 'speak', '主动开口', '休息提醒', '久坐'],
  ['water', 'speak', '主动开口', '喝水提醒', '喝水 久坐'],
  ['n_done', 'speak', '事情怎么告诉你', '完成', '通知 提醒方式 出声 卡片'],
  ['n_appr', 'speak', '事情怎么告诉你', '待批准', '通知 审批'],
  ['n_err', 'speak', '事情怎么告诉你', '出错', '通知 失败'],
  ['n_brief', 'speak', '事情怎么告诉你', '简短播报', '通知'],
  ['n_remind', 'speak', '事情怎么告诉你', '提醒', '通知 提醒 闹钟'],
  ['sysnotify', 'speak', '事情怎么告诉你', '她不在桌面时改走 macOS 通知', '系统通知 全屏'],
  ['capHide', 'speak', '事情怎么告诉你', '录屏和共享屏幕时隐藏她', '录屏 共享屏幕 隐藏 介绍视频'],
  ['switchTitle', 'speak', '事情怎么告诉你', '切换角色时的雷霆大字', '雷霆大字 切换角色 名字 大字 标题'],
  ['testcard', 'speak', '事情怎么告诉你', '发送测试卡', '测试 通知卡', true],
  ['k_ask', 'perm', '自主程度', '允许她提问和请你批准', '确认 批准 授权 审批 提问'],
  ['plugins.computer_use', 'perm', '能力', '操作电脑', 'computer use 电脑操作 控制 点击'],
  ['plugins.personal_agent', 'perm', '能力', '派发任务和定时任务', '个人代理 派发任务 定时任务 交付 工作区'],
  ['scope', 'perm', '能力', '她能读的文件夹', '资料范围 文件夹 授权 撤销授权'],
  ['plugins.external_access', 'perm', '能力', '外部智能体接入', 'MCP CLI 接入 外部 agent'],
  ['plugins.motion_generation', 'perm', '能力', '生成新动作', 'Kimodo 动作 生成 GPU'],
  ['motionUrl', 'perm', '能力', '动作服务地址', 'Kimodo 动作 生成 GPU 地址'],
  ['motionToken', 'perm', '能力', '动作服务令牌', 'Kimodo 动作 令牌 token'],
  ['perms', 'perm', '系统权限', '系统权限', '权限 TCC 屏幕录制 辅助功能 麦克风 输入监控 自动化 通知'],
  ['screenRecording', 'perm', '系统权限', '屏幕录制', 'TCC 截图'],
  ['accessibility', 'perm', '系统权限', '辅助功能', 'TCC'],
  ['microphone', 'perm', '系统权限', '麦克风与语音识别', 'TCC'],
  ['inputMonitoring', 'perm', '系统权限', '输入监控', 'TCC 按住说话 热键'],
  ['automation', 'perm', '系统权限', '自动化', 'TCC 浏览器 终端'],
  ['notifications', 'perm', '系统权限', '通知权限', 'TCC 系统通知'],
  ['out', 'privacy', '外发', '会离开这台电脑的', '外发 外发总览 云端 截图 流向'],
  ['plugins.screen_awareness', 'privacy', '屏幕感知', '屏幕感知', '观察 屏幕 活动 注意力 窗口文字 时间线 浏览器'],
  ['wintext', 'privacy', '屏幕感知', '窗口文字', '屏幕 文字'],
  ['grain', 'privacy', '屏幕感知', '看多细', '粒度 屏幕理解'],
  ['web', 'privacy', '屏幕感知', '网页正文', '浏览器 网页'],
  ['typing', 'privacy', '屏幕感知', '你输入的文字', '键盘 打字 输入'],
  ['actions', 'privacy', '屏幕感知', '操作时间线', '时间线 操作 点击 窗口'],
  ['keys', 'privacy', '屏幕感知', '键鼠计数', '键盘 鼠标'],
  ['plugins.screen_reading', 'privacy', '屏幕识读', '屏幕识读', '识读 截图 框选 剪贴板 选中文字'],
  ['shot', 'privacy', '屏幕识读', '识读时附上截图', '截图 识读 额度'],
  ['plugins.coding_sessions', 'privacy', '编码会话', '编码会话', 'Claude Code Codex hook 会话 审批'],
  ['agent_sessions', 'privacy', '编码会话', '读会话里的工具输入输出', 'Claude Code Codex 工具 输入 输出 结果'],
  ['hooks', 'privacy', '编码会话', 'Claude Code / Codex 接入', 'hooks 绑定 解绑'],
  ['plugins.daily_brief', 'privacy', '每日简报', '每日简报', '日报 简报 工业简报 今天 周报 工作记录'],
  ['brief_daily', 'privacy', '每日简报', '每日简报', '简报 日报'],
  ['brief_weekly', 'privacy', '每日简报', '每周简报', '简报 周报'],
  ['mask', 'privacy', '遮蔽与排除', '发出前遮蔽敏感内容', '遮蔽 密钥 邮箱'],
  ['exclude', 'privacy', '遮蔽与排除', '不看的应用和网站', '黑名单 排除 不看 白名单'],
  ['kcur', 'kernel', '当前内核', '当前内核 │ 重新检测', '运行时 codex claude 登录 内核 pi 能力'],
  ['piApproval', 'kernel', 'Pi', '写文件和运行命令前先问你', '工具审批 批准 确认 审批卡 bash powershell write edit pi_tool_approval'],
  ['maxCost', 'kernel', 'Pi', '单次运行费用上限', '预算 限额 费用 max_budget_usd'],
  ['workspace', 'kernel', 'Pi', '工作区', 'workspace 工作目录 文件夹 AgenticComplex'],
  ['runsrc', 'kernel', 'Pi', '运行来源', 'cli 内置'],
  ['piTools', 'kernel', 'Pi', 'Pi 的工具', 'read bash edit write grep find ls shell powershell rg fd'],
  ['plugins.harness_bridge', 'kernel', '外接 harness', '外接 harness', 'Agent 内核桥接 harness Claude Code Codex ACP 内核'],
  ['kernel', 'kernel', '外接 harness', '换内核', 'codex claude pi acp 内核 选择内核'],
  ['exe', 'kernel', '外接 harness', '可执行文件', '路径'],
  ['acpAgent', 'kernel', '外接 harness', 'ACP 智能体', 'acp claude gemini npx uvx 下载 agent'],
  ['acct', 'kernel', '外接 harness', '账号来源', '登录 凭据'],
  ['provider', 'kernel', '外接 harness', '服务提供方', 'openai anthropic deepseek xai grok 兼容'],
  ['mainModel', 'kernel', '外接 harness', '主会话模型', '模型'],
  ['routes', 'kernel', '外接 harness', '按用途指定内核', '用途 对话 后台 判断 理解 记忆 电脑操控 模型 强度 思考'],
  ['svc', 'model', '模型服务', '模型服务', 'pi anthropic deepseek grok xai openai 兼容 chatgpt 订阅 服务提供方 目录 openrouter groq mistral moonshot qwen zai'],
  ['apiBase', 'model', '模型服务', 'API 地址', 'pi url'],
  ['apikey', 'model', '模型服务', 'API Key', 'pi 密钥 凭据'],
  ['chatModel', 'model', '默认模型', '模型', 'pi 默认模型'],
  ['think', 'model', '默认模型', '思考强度', 'pi 推理'],
  ['mtest', 'model', '默认模型', '测试连接', '测试 连通'],
  ['ctxWindow', 'model', '默认模型', '上下文长度', 'pi 兼容 context'],
  ['maxOut', 'model', '默认模型', '最大输出', 'pi 兼容 max tokens'],
  ['images', 'model', '默认模型', '图像输入', 'pi 兼容 图片 视觉'],
  ['reasoning', 'model', '默认模型', '思考', 'pi 兼容 推理 reasoning'],
  ['hk_ptt', 'keys', '全局快捷键', '按住说话', '语音 热键'],
  ['hk_quick', 'keys', '全局快捷键', '快速输入', '热键 输入'],
  ['hk_look', 'keys', '全局快捷键', '屏幕识读', '截图 热键 识读'],
  ['hk_hide', 'keys', '全局快捷键', '显示 / 隐藏角色', '热键'],
  ['hk_pass', 'keys', '全局快捷键', '临时全部点穿', '点穿 热键'],
  ['hk_wheel', 'keys', '全局快捷键', '快捷轮盘', '指令环 热键'],
  ['hk_sel', 'keys', '全局快捷键', '读取选中文字', '选中 剪贴板 复制 热键'],
  ['hk_cmdk', 'keys', '主窗口里', '命令面板', '⌘K 热键 快捷键'],
  ['archive', 'data', '保留', '历史保留多久', '归档 保留 清理 7 天 30 天 trace 用量'],
  ['datadir', 'data', '保留', '数据文件夹', '文件夹 打开', true],
  ['delrecent', 'data', '删除', '删掉最近看到的', '删除 最近 截图 观察', true],
  ['delact', 'data', '删除', '清空活动记录', '删除 清空', true],
  ['reset', 'data', '删除', '恢复默认设置', '重置 默认', true],
  ['delall', 'data', '删除', '删除所有本地数据', '清空 删除', true],
  ['ver', 'about', '关于', '版本', '开发版 正式版 系统 macOS 复制版本信息'],
  ['login', 'about', '启动', '开机登录后启动', '登录项 开机 登录时启动'],
  ['copydiag', 'about', '排障', '复制诊断信息', '诊断', true],
  ['logdir', 'about', '排障', '日志目录', '日志', true],
  ['onb', 'about', '排障', '重新运行首次设置', '引导 首次', true],
  ['fonts', 'about', '排障', '字体许可', '许可 字体', true],
  ['dev', 'about', '排障', '开发者模式', '诊断 调试 开发'],
  ['agentd', 'about', '排障', '后台服务', 'agentd 重启'],
  ['devparams', 'about', '排障', '启动参数', 'agentd_port tts_url 配置文件 开发者参数'],
  ['pause', '@overview', '每日简报 › 暂停', '暂停观察 1 小时', '暂停 观察 截图', true],
  ['dnd_quiet', '@overview', '每日简报 › 免打扰', '免打扰（30 分钟 / 1 小时 / 到明早 / 开会）', '免打扰 开会 会议 共享屏幕 勿扰 静音', true],
  ['beh.stay', '@character', '角色 › 行为', '待在原地 / 自由活动', '行为 半身固定 半身 上半身 机位'],
  ['beh.range', '@character', '角色 › 行为', '活动范围', '行为'],
  ['avatar_click', '@character', '角色 › 行为', '点击角色', '角色互动 摸头 问候 打开快速输入 打字'],
  ['rnd.fps', '@character', '角色 › 画面', '帧率上限', 'fps 画面'],
  ['scn.mode', '@character', '角色 › 场景', '场景', '场景 舞台盒 展示台 背景'],
  ['scn.parallax', '@character', '角色 › 场景', '背景视差', '视差 背景 场景'],
  ['beh.sit', '@character', '角色 › 行为', '坐在窗口顶上', '行为 窗口 坐'],
  ['beh.lean', '@character', '角色 › 行为', '扶着窗沿', '行为 窗沿 扶'],
  ['beh.inertia', '@character', '角色 › 行为', '拖动惯性', '拖动 滑行 惯性'],
  ['beh.watch', '@character', '角色 › 行为', '陪看朝向', '朝向 侧身 转身 面向'],
  ['beh.mouse', '@character', '角色 › 行为', '看向鼠标', '视线 注视 光标 鼠标'],
  ['beh.touch', '@character', '角色 › 行为', '点不同部位有不同反应', '触摸 部位 点击 反应'],
  ['beh.pat', '@character', '角色 › 行为', '摸头', '摸头 抚摸 触摸'],
  ['beh.pinch', '@character', '角色 › 行为', '捏脸（按住脸颊拖动）', '捏脸 脸颊 触摸'],
  ['beh.greet', '@character', '角色 › 行为', '锁屏或睡眠回来时迎接', '迎接 问候 锁屏 睡眠 唤醒'],
  ['beh.mood', '@character', '角色 › 行为', '状态影响行为', '精神 心情 状态'],
  ['beh.face', '@character', '角色 › 行为', '说话时有表情', '表情 说话 语气'],
  ['beh.rail', '@character', '角色 › 行为', '头顶任务与角色状态', '头顶 任务 状态 浮层'],
  ['beh.hint', '@character', '角色 › 行为', '悬浮快捷键提示', '悬浮 提示 快捷键'],
  ['rnd.cam', '@character', '角色 › 画面', '原作镜头预设', '镜头 相机 预设 展示 总览 档案'],
  ['rnd.yaw', '@character', '角色 › 画面', '水平朝向', '镜头 绕转 水平 yaw'],
  ['rnd.pitch', '@character', '角色 › 画面', '俯仰朝向', '镜头 俯仰 pitch'],
  ['rnd.lightYaw', '@character', '角色 › 画面', '主光水平微调', '主光 光照 水平'],
  ['rnd.lightPitch', '@character', '角色 › 画面', '主光俯仰微调', '主光 光照 俯仰'],
  ['rnd.lightStrength', '@character', '角色 › 画面', '主光强度', '主光 光照 亮度 强度'],
  ['rnd.outline', '@character', '角色 › 画面', '角色边界', '描边 轮廓 外轮廓 边界'],
  ['rnd.ground', '@character', '角色 › 画面', '脚下阴影', '阴影 接触阴影 落地 脚下'],
  ['rnd.ambient', '@character', '角色 › 画面', '环境取色', '环境 取色 壁纸 屏幕 补光'],
  ['rnd.wrap', '@character', '角色 › 画面', '边缘环境光', '边缘光 环境光 轮廓 背景色'],
  ['rnd.filter', '@character', '角色 › 画面', '滤镜', '滤镜 拍照 调色 黑金 温暖 苍白 胶片 希望色彩 血忆 武陵印象 明亮 冷调 清新 暗色 黑白 春 文艺 蓝橙'],
  ['rnd.dof', '@character', '角色 › 画面', '景深', '景深 虚化 近景 焦点 光圈'],
  ['rnd.idle', '@character', '角色 › 画面', '空闲时降到 30 fps', '帧率 节能 空闲 fps'],
  ['rnd.batt', '@character', '角色 › 画面', '电池供电时降帧', '帧率 电池 节能 fps'],
  ['rnd.aa', '@character', '角色 › 画面', '2× SSAA', '抗锯齿 超采样 ssaa 画质'],
  ['rnd.size', '@character', '角色 › 画面', '渲染尺寸', '分辨率 显示像素 画质'],
  ['rnd.shadow', '@character', '角色 › 画面', '自阴影精度', '阴影 精度 画质'],
  ['beh.physics', '@character', '角色 › 行为', '头发衣物物理', '物理 头发 衣物 裙摆 摆动'],
  ['rnd.zoom', '@character', '角色 › 画面', '镜头缩放', '镜头 缩放 放大 近景 取景'],
  ['rnd.sway', '@character', '角色 › 画面', '呼吸晃动', '镜头 晃动 呼吸 手持'],
  ['rnd.closeup', '@character', '角色 › 画面', '对话近景', '镜头 近景 对话 会话 推近'],
  ['rnd.track', '@character', '角色 › 画面', '动作相机轨', '镜头 相机 相机轨 舞台 动作'],
  ['about-you', '@memory', '记忆 › 用户档案', '称呼、生日', '用户档案'],
];

const DELETES = new Set(['wintext', 'web', 'typing', 'agent_sessions', 'delrecent', 'delact', 'delall']);

/** Rows nested in a capability's band that protocol/plugins/plugins.json does not list by row. */
const BAND_ROWS: Readonly<Record<string, PluginId>> = {
  motionUrl: 'motion_generation',
  motionToken: 'motion_generation',
  hooks2: 'coding_sessions',
  ...Object.fromEntries(
    ['kernel', 'exe', 'acpAgent', 'acct', 'provider', 'mainModel', 'routes', ...ROUTES.flatMap((p) => Object.values(routeIds(p)))].map((id) => [id, 'harness_bridge' as const]),
  ),
};

/** Rows a plug-in owns: the `<group>.<row>` entries of its `web.settings` in protocol/plugins/plugins.json, and the band rows above. */
const ROW_PLUGIN: Readonly<Record<string, PluginId>> = {
  ...BAND_ROWS,
  ...Object.fromEntries(PLUGINS.flatMap((p) => (p.web.settings as readonly string[]).flatMap((s) => (s.includes('.') ? [[s.slice(s.indexOf('.') + 1), p.id]] : [])))),
};

/** Rows only a developer needs. */
const DEV_ROWS: ReadonlySet<string> = new Set(['ttsTunnelHost', 'ttsEnsureScript', 'testcard', 'exe', 'provider', 'mainModel', 'routes', 'runsrc', 'piTools', 'agentd', 'devparams']);

export const REGISTRY: RegEntry[] = RAW.map(([id, group, section, label, keywords = '', action]) => {
  const plugin = ROW_PLUGIN[id];
  return {
    id,
    group,
    section,
    label,
    keywords,
    effect: action ? 'action' : DRAFT_SECTION[id] ? 'groupApply' : 'instant',
    deletesData: DELETES.has(id),
    ...(plugin ? { plugin } : {}),
    ...(DEV_ROWS.has(id) ? { dev: true as const } : {}),
  };
});

/** Rows that name macOS: their label and keywords on the Windows shell. */
const WINDOWS_TEXT: Readonly<Record<string, Pick<RegEntry, 'label' | 'keywords'>>> = {
  sysnotify: { label: '她不在桌面时改走 Windows 通知', keywords: '系统通知 全屏' },
  ver: { label: '版本', keywords: '开发版 正式版 系统 Windows 复制版本信息' },
};

// Not getBridge(): the fake bridge's demo data imports this module, so that import would be circular.
function onShell(r: RegEntry): RegEntry {
  const text = WINDOWS_TEXT[r.id];
  return text && window.agenticComplex?.platform === 'windows' ? { ...r, ...text } : r;
}

export function labelOf(id: string): string {
  const r = REGISTRY.find((x) => x.id === id);
  return r ? onShell(r).label : id;
}

export function groupOf(id: string): GroupId | null {
  const g = REGISTRY.find((r) => r.id === id)?.group;
  return g && isGroup(g) ? g : null;
}

/** Case-insensitive match on label, section and keywords. */
export function searchSettings(q: string): RegEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return REGISTRY.map(onShell).filter((r) => `${r.label} ${r.section} ${r.keywords}`.toLowerCase().includes(needle));
}

type HelperBit = 'helperPushToTalk' | 'helperWindowText' | 'helperTypedText' | 'helperActionTimeline' | 'helperSelectedText';

/** Rows whose feature needs platform helper ops: the capability bit that says the running helper has them. */
const ROW_HELPER: Readonly<Record<string, HelperBit>> = {
  hk_ptt: 'helperPushToTalk', asr: 'helperPushToTalk', wintext: 'helperWindowText', grain: 'helperWindowText',
  typing: 'helperTypedText', actions: 'helperActionTimeline', hk_sel: 'helperSelectedText',
};

const ALL_HELPER: Readonly<Record<HelperBit, true>> = { helperPushToTalk: true, helperWindowText: true, helperTypedText: true,
  helperActionTimeline: true, helperSelectedText: true };

/** Whether a row shows: its plug-in is on, a developer row only in 开发者模式, and a row needing helper ops only when the helper has them. Ids outside the registry count too. */
export function rowShown(id: string, plugins: PluginState, devMode: boolean, caps: Readonly<Pick<Capabilities, HelperBit>>): boolean {
  const p = ROW_PLUGIN[id];
  const bit = ROW_HELPER[id];
  return (!p || plugins[p]) && (devMode || !DEV_ROWS.has(id)) && (!bit || caps[bit]);
}

export function useRowShown(): (id: string) => boolean {
  const plugins = usePlugins();
  const devMode = useDevMode();
  // The fake bridge's helper has every op.
  const caps = window.agenticComplex?.capabilities ?? ALL_HELPER;
  return useCallback((id: string) => rowShown(id, plugins, devMode, caps), [plugins, devMode, caps]);
}
