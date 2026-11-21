import type { Demo } from '../../shell/types';
import { C2 } from '../../mock/fixtures/ids';

// Every state below must open by URL and look right; `full` is the prototype comparison (with fields agentd lacks).
export const demos: Demo[] = [
  { name: 'default', params: {} },
  { name: 'full', params: { demo: 'full' } }, // 后端未提供的字段也画出：判断、缓存与费用、动作时长、观察窗口、新增记忆
  { name: 'sparse', params: { demo: 'sparse' } }, // 数据少：一段对话、四轮
  { name: 'turn', params: { turn: 'tr7' } }, // 轮次详情打开
  { name: 'full-turn', params: { demo: 'full', turn: 'tr7' } }, // 轮次详情打开，含后端未提供的字段
  { name: 'light', params: { theme: 'light' } }, // 亮色主题
  { name: 'loading', params: { state: 'loading' } }, // 加载
  { name: 'empty', params: { state: 'empty' } }, // 没有对话：新建对话
  { name: 'error', params: { state: 'error' } }, // 读取失败
  { name: 'disconnected', params: { demo: 'disconnected' } }, // 后台断开：保留上次数据并标时间、查看诊断、重试
  { name: 'sendfail', params: { demo: 'sendfail' } }, // 发送失败：原因 + 重新发送，保留原文
  { name: 'kernel', params: { demo: 'kernel' } }, // 内核未就绪：KernelChain；读 /character/runtime?demo=logged-out
  { name: 'history', params: { demo: 'history', conv: C2 } }, // 历史对话
  { name: 'plan-snapshot', params: { demo: 'plan-snapshot' } }, // 右栏任务页签：计划取 run 的 plan item，没有就写「还没有计划」
  { name: 'reject', params: { demo: 'reject' } }, // 右栏任务页签：补充要求框展开
];
