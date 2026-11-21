import type { Demo } from '../../shell/types';

export const demos: Demo[] = [
  { name: 'default', params: {} },
  { name: 'ok', params: { demo: 'ok' } }, // 原型「正常」：两项开关未保存
  { name: 'full', params: { demo: 'full' } }, // 含真实接口还没有的区块：今日播放、显示武器（只在假桥下）
  { name: 'sparse', params: { demo: 'sparse' } }, // 数据少：播放很少
  { name: 'light', params: { theme: 'light' } }, // 亮色主题
  { name: 'loading', params: { state: 'loading' } }, // 加载
  { name: 'error', params: { state: 'error' } }, // 读取失败
  { name: 'playing', params: { demo: 'playing' } }, // 桌面预览播放中
  { name: 'disconnected', params: { demo: 'disconnected' } }, // 后台断开：标出上次读到状态的时间
  { name: 'offline', params: { demo: 'offline' } }, // 角色未运行：只读，[重启角色]
  { name: 'switching', params: { demo: 'switching' } }, // 切换进行中
  { name: 'switchfail', params: { demo: 'switchfail' } }, // 切换被拒绝，停在那一格写原因
  { name: 'switch-confirm', params: { demo: 'switch-confirm' } }, // 切换前确认
  { name: 'state-none', params: { demo: 'state-none' } }, // 状态还没开始记录
];
