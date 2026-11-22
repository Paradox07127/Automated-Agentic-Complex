import type { Demo } from '../../shell/types';

// Every state below must open by URL and look right.
export const demos: Demo[] = [
  { name: 'default', params: {} },
  { name: 'render', params: { tab: 'render' } }, // 画质页签
  { name: 'light', params: { theme: 'light' } }, // 亮色主题
  { name: 'render-light', params: { tab: 'render', theme: 'light' } }, // 画质页签，亮色
  { name: 'sparse', params: { demo: 'sparse' } }, // 数据少：状态 13:20 起记录，没有决策
  { name: 'loading', params: { state: 'loading' } }, // 加载
  { name: 'error', params: { state: 'error' } }, // 读取失败
  { name: 'offline', params: { demo: 'offline' } }, // 角色未运行：在做写「—」
  { name: 'render-offline', params: { tab: 'render', demo: 'offline' } }, // 角色未运行：画质三行只读，底栏重启角色
  { name: 'disconnected', params: { demo: 'disconnected' } }, // 后台断开：曲线停在断开时间
  { name: 'state-none', params: { demo: 'state-none' } }, // 状态还没开始记录
  { name: 'render-suspended', params: { tab: 'render', demo: 'suspended' } }, // 画面暂停中：宿主不发读数
];
