import type { Demo } from '../../shell/types';

// Every state below must open by URL and look right; `full` draws what agentd does not send yet (judge, cache and cost).
export const demos: Demo[] = [
  { name: 'default', params: {} },
  { name: 'full', params: { demo: 'full' } }, // 原型数据：四轮，判断概率、缓存与费用
  { name: 'full-turn', params: { demo: 'full', turn: 'tr7' } }, // 打开指定一轮：/trace?turn=<id>
  { name: 'sparse', params: { demo: 'sparse' } }, // 数据少：四轮
  { name: 'light', params: { theme: 'light' } }, // 亮色主题
  { name: 'logs', params: { tab: 'logs' } }, // 日志页签
  { name: 'logs-agentd', params: { tab: 'logs', src: 'agentd' } }, // 从诊断页进程行进来：只看后台服务
  { name: 'loading', params: { state: 'loading' } }, // 加载
  { name: 'empty', params: { state: 'empty' } }, // 最近 24 h 没有轮次
  { name: 'error', params: { state: 'error' } }, // 读取失败
];
