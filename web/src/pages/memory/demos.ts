import type { Demo } from '../../shell/types';
import { v31Id } from '../../mock/fixtures/ids';

// Demo list: every state below must open by URL.
export const demos: Demo[] = [
  { name: 'default', params: {} }, // 档案：有待确认时停在投票卡
  { name: 'sparse', params: { demo: 'sparse' } }, // 数据少：6 条，无待确认，停在全部
  { name: 'empty', params: { state: 'empty' } }, // 空
  { name: 'paused', params: { demo: 'paused' } }, // 已暂停
  { name: 'loading', params: { state: 'loading' } }, // 加载中
  { name: 'error', params: { state: 'error' } }, // 读取失败
  { name: 'light', params: { theme: 'light' } }, // 亮色
  { name: 'detail', params: { sel: v31Id('g2') } }, // 选中一条：右栏详情，窄窗是抽屉
  { name: 'filter', params: { src: 'observed' } }, // 记忆管线按来源跳来：搜「观察所得」
  { name: 'search', params: { q: '周报' } }, // 搜索
  { name: 'projects', params: { plugins: 'daily_brief', view: 'projects' } }, // 项目：工作记忆的任务
  { name: 'review', params: { plugins: 'screen_awareness', view: 'activity' } }, // 回顾：工作片段和原始观察
  { name: 'projects-off', params: { view: 'projects' } }, // 每日简报关着：项目整页已关闭
  { name: 'review-off', params: { view: 'activity' } }, // 屏幕感知关着：回顾整页已关闭
  { name: 'absent', params: { plugins: 'daily_brief', demo: 'absent', view: 'projects' } }, // agentd 没有 /memory/tasks：项目整页未接入
  { name: 'disconnected', params: { demo: 'disconnected' } }, // 后台断开：档案整页未接入
  { name: 'pipeline', params: { view: 'pipeline' } }, // 管线（开发者模式）：选中整理
  { name: 'pipeline-obs', params: { view: 'pipeline', station: 'obs' } }, // 管线 观察：额度和最近请求
  { name: 'pipeline-interp', params: { view: 'pipeline', station: 'interp' } }, // 管线 理解：她现在的理解和最近理解
  { name: 'pipeline-store', params: { view: 'pipeline', station: 'store' } }, // 管线 记忆库：按来源和 14 天新增
  { name: 'pipeline-run', params: { view: 'pipeline', run: 'mrun-00' } }, // 管线：打开一批的生成记录
  { name: 'pipeline-error', params: { view: 'pipeline', state: 'error' } }, // 管线：后台断开
];
