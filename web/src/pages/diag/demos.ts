import type { Demo } from '../../shell/types';

// Every state below must open by URL and look right.
export const demos: Demo[] = [
  { name: 'default', params: {} },
  { name: 'sparse', params: { demo: 'sparse' } }, // 数据稀疏：今天 9 轮，近 1 小时 3 轮
  { name: 'light', params: { theme: 'light' } }, // 亮色主题
  { name: 'loading', params: { state: 'loading' } }, // 加载
  { name: 'error', params: { state: 'error' } }, // 后台断开：读不到诊断状态
  { name: 'proc', params: { tab: 'proc', demo: 'full' } }, // 进程页签：每个进程一行曲线
  { name: 'render', params: { tab: 'render' } }, // 帧与负载页签：帧率和帧耗时
  { name: 'flow', params: { tab: 'flow', demo: 'full' } }, // 链路页签：轮次管道、近 24 小时、模型调用
  { name: 'full', params: { demo: 'full' } }, // 后端还没有的区块：各节点的小时汇总（次数、失败、编码 hook 一路的耗时）、进程 CPU 和内存历史、在线时段
  { name: 'disconnected', params: { demo: 'disconnected' } }, // 读到过数据后断开：标「后台已断开」和数据时刻
  { name: 'paused', params: { demo: 'paused' } }, // 暂停刷新
  { name: 'state', params: { tab: 'state' } }, // 内部状态页签：当前轮、主动发言闸门、现在
  { name: 'confirm', params: { demo: 'confirm' } }, // 全部重启确认
  { name: 'empty', params: { state: 'empty' } }, // 最近 24 h 没有轮次
  // 回看; `full` fills every optional field agentd sends (judge, cache and cost); a live turn has cost only when its harness reported one.
  { name: 'turns', params: { tab: 'turns' } }, // 对话轮次
  { name: 'turns-full', params: { tab: 'turns', demo: 'full' } }, // 原型数据：四轮，判断概率、缓存与费用
  { name: 'turns-pick', params: { tab: 'turns', demo: 'full', turn: 'tr7' } }, // 打开指定一轮：?tab=turns&turn=<id>
  { name: 'turns-sparse', params: { tab: 'turns', demo: 'sparse' } }, // 数据少：四轮
  { name: 'turns-light', params: { tab: 'turns', theme: 'light' } }, // 亮色主题
  { name: 'turns-empty', params: { tab: 'turns', state: 'empty' } }, // 最近 24 h 没有轮次
  { name: 'turns-error', params: { tab: 'turns', state: 'error' } }, // 读取失败
  { name: 'lanes', params: { tab: 'lanes' } }, // 事件线：每种事件、一次拒绝、你自己的播放、渲染器断线
  { name: 'behavior', params: { tab: 'behavior' } }, // 行为决策
  { name: 'behavior-light', params: { tab: 'behavior', theme: 'light' } }, // 行为决策，亮色
  { name: 'behavior-sparse', params: { tab: 'behavior', demo: 'sparse' } }, // 数据少：状态 13:20 起记录，没有决策
  { name: 'behavior-offline', params: { tab: 'behavior', demo: 'offline' } }, // 角色未运行：在做写「—」
  { name: 'behavior-disconnected', params: { tab: 'behavior', demo: 'disconnected' } }, // 后台断开：曲线停在断开时间
  { name: 'behavior-none', params: { tab: 'behavior', demo: 'state-none' } }, // 状态还没开始记录
  { name: 'logs', params: { tab: 'logs' } }, // 日志页签
  { name: 'logs-agentd', params: { tab: 'logs', src: 'agentd' } }, // 从进程行进来：只看后台服务
];
