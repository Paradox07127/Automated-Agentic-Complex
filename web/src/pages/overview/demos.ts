import type { Demo } from '../../shell/types';

// Demo list is the to-do list: every state below must open by URL and look right (prototype-v3 home ok / sparse / loading / error).
export const demos: Demo[] = [
  { name: 'default', params: {} },
  { name: 'sparse', params: { demo: 'sparse' } }, // 数据少：没有待处理和编码会话，一段对话
  { name: 'light', params: { theme: 'light' } }, // 亮色主题
  { name: 'loading', params: { state: 'loading' } }, // 加载
  { name: 'error', params: { state: 'error' } }, // 刷新失败：保留上次数据并标时间
  { name: 'full', params: { demo: 'full' } }, // 全量数据，看高窗口（≥1000 高）的放大版
  { name: 'empty', params: { state: 'empty' } }, // 空：今天什么都没有
  { name: 'fail', params: { demo: 'fail' } }, // 待处理读不到，其余区块照常
  { name: 'agentd-off', params: { demo: 'disconnected' } }, // 后台断开：显示上次数据并标时间
  { name: 'decided', params: { demo: 'decided' } }, // 第一条批准后换到下一条
  { name: 'pause', params: { demo: 'pause' } }, // 观察暂停，还剩 18 分
  { name: 'quiet', params: { demo: 'quiet' } }, // 免打扰·安静，还剩 58 分
  { name: 'palette', params: { demo: 'palette' } }, // ⌘K 命令面板
  { name: 'absent', params: { demo: 'absent' } }, // 工作记忆的接口不在：今日一句用今天的读数
  { name: 'screen', params: { sw: 'scr,read' } }, // 只开屏幕感知和窗口文字：读数带 3 项补位，没有做完了和在做，右栏是前一天的观察日报
  { name: 'voice', params: { sw: 'voice' } }, // 只开语音：读数全是她的数据，没有时间页签，右栏是她今天说的一句
  { name: 'past', params: { date: '2026-10-26' } }, // 往回 3 天：没有待批准和在做，读数和列表按那一天
];
