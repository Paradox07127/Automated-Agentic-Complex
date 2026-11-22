import type { Demo } from '../../shell/types';

export const demos: Demo[] = [
  { name: 'default', params: {} }, // 01 角色：名册和在桌面上
  { name: 'char-empty', params: { demo: 'char-empty' } }, // 01 名册空：先不导入
  { name: 'chat', params: { demo: 'chat' } }, // 02 对话：还没有连接
  { name: 'chat-ok', params: { demo: 'chat-ok' } }, // 02 已连上并测通
  { name: 'chat-off', params: { demo: 'chat-off' } }, // 02 和她对话关着
  { name: 'chat-key', params: { demo: 'chat-key' } }, // 02 API Key 的服务
  { name: 'agentd-off', params: { demo: 'agentd-off' } }, // 02 后台没有运行
  { name: 'voice', params: { demo: 'voice' } }, // 03 声音：麦克风没允许、输入监控没问过
  { name: 'voice-novoice', params: { demo: 'voice-novoice' } }, // 03 她没有声线
  { name: 'done', params: { demo: 'done' } }, // 完成
  { name: 'light', params: { theme: 'light' } },
  { name: 'chat-light', params: { demo: 'chat', theme: 'light' } },
  { name: 'voice-light', params: { demo: 'voice', theme: 'light' } },
  { name: 'done-light', params: { demo: 'done', theme: 'light' } },
  { name: 'loading', params: { state: 'loading' } },
  { name: 'error', params: { state: 'error' } },
];
