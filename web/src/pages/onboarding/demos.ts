import type { Demo } from '../../shell/types';

export const demos: Demo[] = [
  { name: 'default', params: {} },
  { name: 'ok', params: { demo: 'ok' } }, // 第 1 步：系统权限
  { name: 'step2', params: { demo: 'step2' } }, // 第 2 步：按住说话、称呼
  { name: 'step3', params: { demo: 'step3' } }, // 第 3 步：接入编码会话
  { name: 'step4', params: { demo: 'step4' } }, // 完成：角色已就位
  { name: 'denied', params: { demo: 'denied' } }, // 麦克风被拒绝
  { name: 'denied-step2', params: { demo: 'denied-step2' } }, // 麦克风被拒绝时的第 2 步
  { name: 'sparse', params: { demo: 'sparse' } }, // 全新机器：全部未授权、未接入
  { name: 'sparse-step3', params: { demo: 'sparse-step3' } }, // 全新机器的第 3 步：安装命令
  { name: 'light', params: { theme: 'light' } },
  { name: 'step2-light', params: { demo: 'step2', theme: 'light' } },
  { name: 'step4-light', params: { demo: 'step4', theme: 'light' } },
  { name: 'sparse-light', params: { demo: 'sparse', theme: 'light' } },
  { name: 'loading', params: { state: 'loading' } },
  { name: 'error', params: { state: 'error' } },
];
