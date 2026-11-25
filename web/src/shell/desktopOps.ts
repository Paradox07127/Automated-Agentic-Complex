import { create } from 'zustand';
import { getBridge } from '../bridge';
import { serverFaultText } from '../domain/errorText';
import { toast } from './toast';

/** 屏幕识读, 快速输入 and 停止说话: native ops with no capability bit, so the first not_implemented / op_not_allowed turns the entry off. */
export type DesktopOp = 'look' | 'quickInput' | 'stopSpeech';

export const DESKTOP_OFF = '当前平台或版本暂不支持此功能';

const useOff = create<Partial<Record<DesktopOp, string>>>(() => ({}));

/** Why each op is off on this shell; absent while it may work. */
export const useDesktopOff = () => useOff();

/** Tests: turn both entries back on. */
export const resetDesktopOff = () => useOff.setState({}, true);

/** agentd's /look refusals (`blocked` reason, or the error code at the end of a `failed` detail). */
const LOOK_WHY: Record<string, string> = {
  secure_input: '当前处于安全输入状态',
  blacklisted: '前台窗口位于排除名单内',
  paused: '屏幕观察已暂停',
  vision_off: '屏幕截图附带功能未开启',
  no_focus: '未检测到有效前台窗口',
  daily_cap: '今日截图识读次数已达上限',
  hourly_cap: '本小时截图识读次数已达上限',
  min_interval: '触发过于频繁，请稍后再试',
};

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;
const detailOf = (e: unknown) => (e as { detail?: string } | null)?.detail ?? '';

function lookWhy(e: unknown): string {
  const code = codeOf(e);
  if (code === 'offline') return '后台服务已断开';
  // A `failed` detail reads `POST /look status <status> <code>`.
  const failed = code === 'failed' ? /^(\S+ \S+) status (\d+) (\S*)$/.exec(detailOf(e)) : null;
  const fault = failed && serverFaultText({ status: Number(failed[2]), code: failed[3], body: { route: failed[1] } });
  if (fault) return fault;
  const key = code === 'blocked' ? detailOf(e) : detailOf(e).split(' ').pop() ?? '';
  return LOOK_WHY[key] ?? '后台服务未接收该请求';
}

async function runOp(op: DesktopOp, call: () => Promise<unknown>, done: string, fail: (e: unknown) => string) {
  try {
    await call();
    toast(done);
  } catch (e) {
    const code = codeOf(e);
    if (code === 'not_implemented' || code === 'op_not_allowed') {
      useOff.setState({ [op]: DESKTOP_OFF });
      toast(DESKTOP_OFF, { severity: 'danger' });
    } else toast(fail(e), { severity: 'danger' });
  }
}

export const look = () => runOp('look', () => getBridge().app.look(), '正在识读前台窗口', (e) => `屏幕识读未完成：${lookWhy(e)}`);

export const openQuickInput = () => runOp('quickInput', () => getBridge().app.openQuickInput(), '已打开快速输入', () => '无法打开快速输入');

export const stopSpeech = () =>
  runOp('stopSpeech', () => getBridge().avatar.stopSpeech(), '已停止语音播报', (e) => `未能停止语音播报：${codeOf(e) === 'failed' ? '角色渲染进程未连接' : '角色渲染进程无响应'}`);
