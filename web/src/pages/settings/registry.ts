import { useCallback } from 'react';
import { ROUTES, routeIds } from './fields';
import { SETTING_GROUPS } from './groups';
import type { Capabilities } from '../../bridge';
import { PLUGINS } from '../../bridge/plugins.generated';
import { useDevMode } from '../../shell/devMode';
import { usePlugins, type PluginId, type PluginState } from '../../shell/plugins';
import type { IconName } from '../../ui';

export type GroupId = 'speak' | 'perm' | 'privacy' | 'display' | 'kernel' | 'services' | 'keys' | 'data' | 'about';

// 能力, 感知 and 内核 keep the ids 'perm', 'privacy' and 'kernel' that other pages and agentd actions link to.
export const GROUP_IDS: GroupId[] = ['speak', 'perm', 'privacy', 'display', 'kernel', 'services', 'keys', 'data', 'about'];

export const DEFAULT_GROUP: GroupId = 'speak';

export const GROUP_ICON: Record<GroupId, IconName> = {
  speak: 'voice',
  perm: 'tool',
  privacy: 'eye',
  display: 'sun',
  kernel: 'kernel',
  services: 'radio',
  keys: 'keys',
  data: 'data',
  about: 'info',
};

export const GROUP_LABEL: Record<string, string> = Object.fromEntries(SETTING_GROUPS.map((g) => [g.id, g.label]));

/** Rows that exist only while the kernel is Pi; search leaves them out for other kernels. */
export const PI_ONLY_ROWS: ReadonlySet<string> = new Set(['runsrc', 'piApproval', 'piTools', 'maxCost', 'svc', 'apiBase', 'chatModel', 'think', 'mtest', 'ctxWindow', 'maxOut', 'images', 'reasoning']);

/** Rows of the other kernels' account and model; search leaves them out for Pi. */
export const NOT_PI_ROWS: ReadonlySet<string> = new Set(['acct', 'kernelLogin', 'mainModel']);

/** Groups whose values all come from agentd; they turn read-only when the backend is down. */
export const NEEDS_AGENTD: GroupId[] = ['kernel'];

/** Groups holding config.json rows; they turn read-only when the shell cannot read it. */
export const NATIVE_GROUPS: GroupId[] = ['speak', 'perm', 'privacy', 'display', 'services', 'keys', 'about'];

export function isGroup(v: string | null | undefined): v is GroupId {
  return GROUP_IDS.includes(v as GroupId);
}

/** Rows edited as a draft and applied per section. */
export const DRAFT_SECTION: Record<string, string> = {
  kernel: 'kernel', runsrc: 'kernel', exe: 'kernel', workspace: 'kernel', acpAgent: 'kernel', acpLauncher: 'kernel', acct: 'kernel', provider: 'kernel', mainModel: 'kernel',
  ...Object.fromEntries(ROUTES.flatMap((p) => Object.values(routeIds(p)).map((id) => [id, 'kernel']))),
  maxCost: 'kernel', piApproval: 'kernel',
  svc: 'm_acct', piProvider: 'm_acct', apiBase: 'm_acct', chatModel: 'm_chat', think: 'm_chat',
  svc_tts: 'services', svc_motion: 'services', svc_llm: 'services',
};

/** Which group a draft section belongs to (the tab's draft mark). */
export const SECTION_GROUP: Record<string, GroupId> = { kernel: 'kernel', m_acct: 'kernel', m_chat: 'kernel', services: 'services' };

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
  ['mute', 'speak', '语音与播报', '语音播报', '静音 只显示文字 仅文字 语音'],
  ['tts', 'speak', '语音与播报', '语音服务', 'tts 外部 令牌 测试 无法连接 重新连接'],
  ['asr', 'speak', '语音与播报', '语音识别语言', '识别语言 语音识别 中文 英文 English 按住语音输入'],
  ['replyLang', 'speak', '语音与播报', '回复语言', '回答 语言 中文 英文 日文 English 日本語 reply_language 内核'],
  ['speakWhen', 'speak', '主动交互', '主动交互', '主动发言 主动提示 仅响应对话 自动触发'],
  ['proactive', 'speak', '主动交互', '主动交互频率', '主动程度 频率 均衡 高频 静默'],
  ['quiet_hours', 'speak', '主动交互', '免打扰时段', '勿扰 夜间 时段 添加时段'],
  ['mutes', 'speak', '主动交互', '已关闭的主动交互类别', '关闭此类 恢复 休息提醒 喝水提醒'],
  ['n_done', 'speak', '通知送达', '完成', '通知 提醒方式 卡片并提示音 仅显示卡片'],
  ['n_appr', 'speak', '通知送达', '待批准', '通知 审批'],
  ['n_err', 'speak', '通知送达', '出错', '通知 失败'],
  ['n_brief', 'speak', '通知送达', '简短播报', '通知'],
  ['n_remind', 'speak', '通知送达', '提醒', '通知 提醒 闹钟'],
  ['sysnotify', 'speak', '通知送达', '使用系统通知', '系统通知 全屏'],
  ['testcard', 'speak', '通知送达', '发送测试卡片', '测试 通知卡', true],
  ['k_ask', 'perm', '提问', '允许角色通过提问卡向用户提问', '提问 提问卡 澄清 补充信息'],
  ['plugins.computer_use', 'perm', '能力', '电脑操作', 'computer use 电脑操作 控制 点击'],
  ['plugins.personal_agent', 'perm', '能力', '派发任务与定时任务', '个人代理 派发任务 定时任务 交付 工作区'],
  ['scope', 'perm', '能力', '授权访问目录', '资料范围 文件夹 授权 撤销授权'],
  ['plugins.external_access', 'perm', '能力', '外部接入', 'MCP CLI 接入 外部智能体'],
  ['plugins.motion_generation', 'perm', '能力', '动作生成', 'Kimodo 动作 生成 GPU'],
  ['perms', 'perm', '系统权限', '系统权限', '权限 TCC 屏幕录制 辅助功能 麦克风 输入监控 自动化 通知'],
  ['screenRecording', 'perm', '系统权限', '屏幕录制', 'TCC 截图'],
  ['accessibility', 'perm', '系统权限', '辅助功能', 'TCC'],
  ['microphone', 'perm', '系统权限', '麦克风与语音识别', 'TCC'],
  ['inputMonitoring', 'perm', '系统权限', '输入监控', 'TCC 按住语音输入 快捷键'],
  ['automation', 'perm', '系统权限', '自动化（终端）', 'TCC 自动化 终端 跳转至终端'],
  ['notifications', 'perm', '系统权限', '通知权限', 'TCC 系统通知'],
  ['out', 'privacy', '外发', '外部数据流向', '外发 外发总览 云端 截图 流向'],
  ['plugins.screen_awareness', 'privacy', '屏幕感知', '屏幕感知', '观察 屏幕 活动 注意力 窗口文本 时间线 浏览器'],
  ['wintext', 'privacy', '屏幕感知', '允许读取窗口文本', '屏幕 文字'],
  ['grain', 'privacy', '屏幕感知', '屏幕读取粒度', '粒度 仅应用状态 焦点内容 窗口摘要'],
  ['web', 'privacy', '屏幕感知', '允许读取网页正文', '浏览器 网页'],
  ['typing', 'privacy', '屏幕感知', '允许读取当前输入文本', '键盘 打字 输入'],
  ['actions', 'privacy', '屏幕感知', '记录操作时间线', '时间线 操作 点击 窗口'],
  ['keys', 'privacy', '屏幕感知', '记录键鼠交互频次', '键盘 鼠标 键鼠计数'],
  ['plugins.screen_reading', 'privacy', '屏幕识读', '屏幕识读', '识读 截图 剪贴板 选中文本'],
  ['shot', 'privacy', '屏幕识读', '屏幕识读时附带截图', '截图 识读 额度'],
  ['plugins.coding_sessions', 'privacy', '编码会话', '编码会话', 'Claude Code Codex hook 会话 审批'],
  ['agent_sessions', 'privacy', '编码会话', '允许读取编码会话', 'Claude Code Codex 工具 输入 输出 结果'],
  ['hooks', 'privacy', '编码会话', 'Claude Code / Codex 接入', 'hooks 绑定 解绑'],
  ['plugins.daily_brief', 'privacy', '每日简报', '每日简报功能', '简报 今日 周报 工作记录'],
  ['brief_daily', 'privacy', '每日简报', '启用每日简报', '简报 日报'],
  ['brief_weekly', 'privacy', '每日简报', '启用每周简报', '简报 周报'],
  ['briefHour', 'privacy', '每日简报', '简报生成时间', '简报 日报 周报 时间'],
  ['mask', 'privacy', '脱敏与过滤', '发送前脱敏敏感信息', '脱敏 遮蔽 密钥 邮箱'],
  ['exclude', 'privacy', '脱敏与过滤', '排除名单与允许名单', '排除名单 仅允许名单'],
  ['appTheme', 'display', '外观', '界面主题', '深色 浅色 跟随系统 外观 dark light'],
  ['winBg', 'display', '外观', '窗口背景', '磨砂 毛玻璃 透明 不透明 背景 外观 vibrancy'],
  ['glassAlpha', 'display', '外观', '磨砂强度', '磨砂 透明度 浓度 背景 外观'],
  ['reduceMotion', 'display', '外观', '减弱动态效果', '动画 动效 动态效果 外观'],
  ['uiZoom', 'display', '外观', '界面缩放', '缩放 放大 缩小 字号 字体大小 外观'],
  ['capHide', 'display', '桌面显示', '屏幕录制或共享时隐藏', '录屏 共享屏幕 隐藏'],
  ['switchTitle', 'display', '桌面显示', '切换角色时显示标题动画', '切换角色 名字 标题 显示'],
  ['plugins.light_ai', 'kernel', '选择内核', '轻量 AI（对话、语音、记忆）', '对话 聊天 轻量 AI 记忆 主动交互 模型账号'],
  ['plugins.harness_bridge', 'kernel', '选择内核', '外部执行内核接入', '执行内核桥接 Claude Code Codex ACP 内核'],
  ['kcur', 'kernel', '选择内核', '当前执行内核 │ 重新检测', '运行时 codex claude 登录 内核 pi 能力'],
  ['kernel', 'kernel', '选择内核', '执行内核', 'codex claude pi acp 内核 选择内核'],
  ['acpAgent', 'kernel', '选择内核', 'ACP 智能体', 'acp claude gemini npx uvx agent'],
  ['svc', 'kernel', '账号', '模型提供方', 'pi anthropic deepseek grok xai openai 兼容 chatgpt 订阅 服务提供方 模型服务 openrouter groq mistral moonshot qwen zai'],
  ['apiBase', 'kernel', '账号', 'API 地址', 'pi url'],
  ['apikey', 'kernel', '账号', 'API Key', 'pi 密钥 凭据'],
  ['acct', 'kernel', '账号', '账号来源', '登录 凭据'],
  ['kernelLogin', 'kernel', '账号', '登录', '登录 登出 账号 浏览器 ChatGPT Claude 订阅'],
  ['provider', 'kernel', '账号', '服务提供方', 'openai anthropic deepseek xai grok 兼容'],
  ['chatModel', 'kernel', '模型', '模型', 'pi 默认模型'],
  ['think', 'kernel', '模型', '思考强度', 'pi 推理'],
  ['mtest', 'kernel', '模型', '测试连接', '测试 连通'],
  ['ctxWindow', 'kernel', '模型', '上下文长度', 'pi 兼容 context'],
  ['maxOut', 'kernel', '模型', '最大输出', 'pi 兼容 max tokens'],
  ['images', 'kernel', '模型', '图像输入', 'pi 兼容 图片 视觉'],
  ['reasoning', 'kernel', '模型', '思考', 'pi 兼容 推理 reasoning'],
  ['mainModel', 'kernel', '模型', '主会话模型', '模型 默认模型'],
  ['routes', 'kernel', '模型', '按用途分配执行内核', '用途 对话 后台 判断 理解 记忆 电脑操作 模型'],
  ['piApproval', 'kernel', 'Pi 运行', '写文件或运行命令前请求批准', '工具审批 批准 确认 审批卡 bash powershell write edit pi_tool_approval'],
  ['maxCost', 'kernel', 'Pi 运行', '单次运行费用上限', '预算 限额 费用 max_budget_usd'],
  ['runsrc', 'kernel', 'Pi 运行', '运行来源', 'cli 内置'],
  ['piTools', 'kernel', 'Pi 运行', 'Pi 内置工具', 'read bash edit write grep find ls shell powershell rg fd'],
  ['workspace', 'kernel', '运行', '工作区', 'workspace 工作目录 文件夹 AgenticComplex'],
  ['exe', 'kernel', '运行', '可执行文件', '路径'],
  ['svc_tts', 'services', '自建服务', '语音服务', 'tts 语音 地址 ssh 隧道 本机 命令 启动脚本 日志 令牌 测试'],
  ['svc_motion', 'services', '自建服务', '动作服务', 'Kimodo 动作 地址 ssh 隧道 本机 命令 启动脚本 日志'],
  ['motionToken', 'services', '自建服务', '动作服务令牌', 'Kimodo 动作 令牌 token'],
  ['proxy', 'services', '网络', '代理', 'proxy HTTP_PROXY HTTPS_PROXY 代理服务器 网络'],
  ['svc_llm', 'services', '自建服务', '自建模型接口（兼容 API）', 'Ollama vLLM 兼容 API openai 模型服务 地址 ssh 隧道 本机 命令 启动脚本 日志 key 密钥'],
  ['hk_ptt', 'keys', '全局快捷键', '按住语音输入', '语音 快捷键'],
  ['hk_quick', 'keys', '全局快捷键', '打开快速输入', '快捷键 输入'],
  ['hk_look', 'keys', '全局快捷键', '触发屏幕识读', '截图 快捷键 识读'],
  ['hk_hide', 'keys', '全局快捷键', '显示或隐藏角色', '快捷键'],
  ['hk_pass', 'keys', '全局快捷键', '切换全局鼠标穿透', '点穿 穿透 快捷键'],
  ['hk_wheel', 'keys', '全局快捷键', '打开快捷轮盘', '指令环 轮盘 快捷键'],
  ['hk_sel', 'keys', '全局快捷键', '读取当前选中文本', '选中 剪贴板 复制 快捷键'],
  ['hk_cmdk', 'keys', '主窗口内', '命令面板', '⌘K 快捷键'],
  ['archive', 'data', '保留', '历史记录保留时长', '归档 保留 清理 7 天 30 天 trace 用量'],
  ['datadir', 'data', '保留', '数据文件夹', '文件夹 打开', true],
  ['delrecent', 'data', '删除', '清除最近观察记录', '删除 最近 截图 观察', true],
  ['delact', 'data', '删除', '清空活动记录', '删除 清空', true],
  ['reset', 'data', '删除', '恢复默认设置', '重置 默认', true],
  ['delall', 'data', '删除', '删除所有本地数据', '清空 删除', true],
  ['ver', 'about', '关于', '版本', '开发版 正式版 系统 macOS 复制版本信息'],
  ['login', 'about', '启动', '登录后自动启动', '登录项 启动应用 开机 自启'],
  ['copydiag', 'about', '排障', '复制诊断信息', '诊断', true],
  ['logdir', 'about', '排障', '日志目录', '日志', true],
  ['onb', 'about', '排障', '重新运行首次设置', '引导 首次', true],
  ['fonts', 'about', '排障', '字体许可', '许可 字体', true],
  ['dev', 'about', '排障', '开发者模式', '诊断 调试 开发'],
  ['agentd', 'about', '排障', '后台服务', 'agentd 重启'],
  ['devparams', 'about', '排障', '启动参数', 'agentd_port 配置文件 开发者参数'],
  ['pause', '@overview', '每日简报 › 暂停', '暂停观察 1 小时', '暂停 观察 截图', true],
  ['dnd_quiet', '@overview', '每日简报 › 免打扰', '免打扰（30 分钟 / 1 小时 / 至次日 / 会议中）', '免打扰 会议 共享屏幕 勿扰 静音', true],
  ['beh.stay', '@character', '角色 › 行为', '活动模式', '行为 半身固定 半身 上半身 机位 原地待机 自由活动'],
  ['beh.range', '@character', '角色 › 行为', '活动范围', '行为'],
  ['avatar_click', '@character', '角色 › 行为', '点击角色', '角色互动 摸头 问候 打开快速输入 打字'],
  ['rnd.fps', '@character', '角色 › 画面', '帧率上限', 'fps 画面 渲染 显示 画质 分辨率 性能'],
  ['scn.mode', '@character', '角色 › 场景', '场景模式', '场景 舞台盒 展示台 背景 显示'],
  ['scn.parallax', '@character', '角色 › 场景', '背景视差', '视差 背景 场景'],
  ['beh.sit', '@character', '角色 › 行为', '允许坐在窗口顶部', '行为 窗口 坐 倚坐 窗顶'],
  ['beh.lean', '@character', '角色 › 行为', '允许扶靠窗口边缘', '行为 窗沿 扶 扶靠 边缘'],
  ['beh.inertia', '@character', '角色 › 行为', '拖动惯性', '拖动 滑行 惯性'],
  ['beh.watch', '@character', '角色 › 行为', '伴随朝向', '朝向 侧身 转身 面向 注视'],
  ['beh.mouse', '@character', '角色 › 行为', '注视鼠标指针', '视线 注视 光标 鼠标 跟随'],
  ['beh.touch', '@character', '角色 › 行为', '分区域触碰响应', '触摸 触碰 部位 区域 点击 反应'],
  ['beh.pat', '@character', '角色 › 行为', '头部抚摸互动', '摸头 抚摸 触摸'],
  ['beh.pinch', '@character', '角色 › 行为', '脸颊捏持互动（按住脸颊拖动）', '捏脸 捏持 脸颊 触摸'],
  ['beh.greet', '@character', '角色 › 行为', '唤醒或解锁时问候', '迎接 问候 锁屏 睡眠 唤醒'],
  ['beh.mood', '@character', '角色 › 行为', '角色状态影响行为表现', '精神 心情 状态 联动 行为'],
  ['beh.face', '@character', '角色 › 行为', '语音同步表情', '表情 说话 语气 对话 联动'],
  ['beh.rail', '@character', '角色 › 行为', '角色状态气泡', '头顶 任务 状态 浮层 浮条 气泡'],
  ['beh.hint', '@character', '角色 › 行为', '悬浮快捷键提示', '悬浮 提示 快捷键'],
  ['rnd.cam', '@character', '角色 › 画面', '镜头预设', '镜头 相机 预设 原作 展示 总览 档案'],
  ['rnd.yaw', '@character', '角色 › 画面', '水平旋转', '镜头 绕转 水平 旋转 朝向 yaw'],
  ['rnd.pitch', '@character', '角色 › 画面', '俯仰角度', '镜头 俯仰 角度 朝向 pitch'],
  ['rnd.lightYaw', '@character', '角色 › 画面', '主光源水平角度', '主光 主光源 光照 水平 角度 微调'],
  ['rnd.lightPitch', '@character', '角色 › 画面', '主光源俯仰角度', '主光 主光源 光照 俯仰 角度 微调'],
  ['rnd.lightStrength', '@character', '角色 › 画面', '主光源强度', '主光 主光源 光照 亮度 强度 渲染'],
  ['rnd.outline', '@character', '角色 › 画面', '角色描边', '描边 轮廓 外轮廓 边界 渲染 画质'],
  ['rnd.ground', '@character', '角色 › 画面', '地面阴影', '阴影 接触阴影 实时投影 落地 脚下 渲染 画质'],
  ['rnd.ambient', '@character', '角色 › 画面', '环境光照取色', '环境 光照 取色 壁纸 屏幕 补光 渲染'],
  ['rnd.wrap', '@character', '角色 › 画面', '边缘环境光', '边缘光 环境光 轮廓 背景色 渲染'],
  ['rnd.dof', '@character', '角色 › 画面', '景深效果', '景深 虚化 近景 焦点 光圈 渲染 画质'],
  ['rnd.weather', '@character', '角色 › 画面', '环境天气', '天气 天气效果 下雨 下雪 雨 雪 晴 湿身 积雪'],
  ['rnd.weatherLevel', '@character', '角色 › 画面', '强度', '天气 强度 雨量 雪量 大雨 小雨'],
  ['rnd.idle', '@character', '角色 › 画面', '空闲时降至 30 fps', '帧率 节能 空闲 降帧 fps 渲染 性能'],
  ['rnd.batt', '@character', '角色 › 画面', '使用电池供电时降低帧率', '帧率 电池 节能 降帧 fps 渲染 性能'],
  ['rnd.aa', '@character', '角色 › 画面', '2× SSAA', '抗锯齿 超采样 ssaa 画质'],
  ['rnd.size', '@character', '角色 › 画面', '渲染尺寸', '分辨率 渲染分辨率 尺寸 显示像素 画质'],
  ['rnd.shadow', '@character', '角色 › 画面', '自阴影精度', '阴影 精度 画质'],
  ['beh.physics', '@character', '角色 › 行为', '头发与衣物物理模拟', '物理 头发 衣物 裙摆 摆动'],
  ['rnd.zoom', '@character', '角色 › 画面', '镜头缩放', '镜头 缩放 放大 近景 取景'],
  ['rnd.sway', '@character', '角色 › 画面', '呼吸微动', '镜头 晃动 呼吸 微动 手持'],
  ['rnd.closeup', '@character', '角色 › 画面', '自动近景切换', '镜头 近景 自动 对话 会话 推近'],
  ['rnd.track', '@character', '角色 › 画面', '舞蹈播放', '舞蹈 MMD 全屏 居中 原地 镜头 相机轨 舞台'],
  ['about-you', '@memory', '记忆 › 用户档案', '称呼、生日等基本信息', '用户档案'],
];

const DELETES = new Set(['wintext', 'web', 'typing', 'agent_sessions', 'delrecent', 'delact', 'delall']);

/** Rows nested in a capability's band that protocol/plugins/plugins.json does not list by row. */
const BAND_ROWS: Readonly<Record<string, PluginId>> = {
  motionToken: 'motion_generation',
  hooks2: 'coding_sessions',
  briefHour: 'daily_brief',
  ...Object.fromEntries(
    ['acpAgent', 'acct', 'kernelLogin', 'provider', 'mainModel', 'routes', ...ROUTES.flatMap((p) => Object.values(routeIds(p)))].map((id) => [id, 'harness_bridge' as const]),
  ),
};

/** Rows a plug-in owns: the `<group>.<row>` entries of its `web.settings` in protocol/plugins/plugins.json, and the band rows above. */
const ROW_PLUGIN: Readonly<Record<string, PluginId>> = {
  ...BAND_ROWS,
  ...Object.fromEntries(PLUGINS.flatMap((p) => (p.web.settings as readonly string[]).flatMap((s) => (s.includes('.') ? [[s.slice(s.indexOf('.') + 1), p.id]] : [])))),
};

/** Rows only a developer needs. */
const DEV_ROWS: ReadonlySet<string> = new Set(['testcard', 'exe', 'provider', 'routes', 'runsrc', 'piTools', 'agentd', 'devparams']);

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

/** Whether a row shows: its plug-in is on, and a developer row only in 开发者模式. Ids outside the registry count too. */
export function rowShown(id: string, plugins: PluginState, devMode: boolean): boolean {
  const p = ROW_PLUGIN[id];
  return (!p || plugins[p]) && (devMode || !DEV_ROWS.has(id));
}

export function useRowShown(): (id: string) => boolean {
  const plugins = usePlugins();
  const devMode = useDevMode();
  return useCallback((id: string) => rowShown(id, plugins, devMode), [plugins, devMode]);
}

/** Whether the row's feature needs helper ops the running helper has not got. */
export function helperLacks(id: string, caps: Readonly<Pick<Capabilities, HelperBit>>): boolean {
  const bit = ROW_HELPER[id];
  return bit != null && !caps[bit];
}

export function useHelperLacks(): (id: string) => boolean {
  // The fake bridge's helper has every op.
  const caps = window.agenticComplex?.capabilities ?? ALL_HELPER;
  return useCallback((id: string) => helperLacks(id, caps), [caps]);
}
