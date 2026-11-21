import { create } from 'zustand';
import { getBridge } from '../bridge';
import { serverFaultText } from '../domain/errorText';
import { toast } from './toast';

/** 屏幕识读, 快速输入 and 停止说话: native ops with no capability bit, so the first not_implemented / op_not_allowed turns the entry off. */
export type DesktopOp = 'look' | 'quickInput' | 'stopSpeech';

export const DESKTOP_OFF = '这个版本的桌面端还不支持';

const useOff = create<Partial<Record<DesktopOp, string>>>(() => ({}));

/** Why each op is off on this shell; absent while it may work. */
export const useDesktopOff = () => useOff();

/** Tests: turn both entries back on. */
export const resetDesktopOff = () => useOff.setState({}, true);

/** agentd's /look refusals (`blocked` reason, or the error code at the end of a `failed` detail). */
const LOOK_WHY: Record<string, string> = {
  secure_input: '正在输入密码',
  blacklisted: '前台窗口在屏蔽名单里',
  paused: '观察已暂停',
  vision_off: '截图没有打开',
  no_focus: '没有找到前台窗口',
  daily_cap: '今日截图额度已用完',
  hourly_cap: '这一小时的截图额度已用完',
  min_interval: '刚看过，稍后再试',
};

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;
const detailOf = (e: unknown) => (e as { detail?: string } | null)?.detail ?? '';

function lookWhy(e: unknown): string {
  const code = codeOf(e);
  if (code === 'offline') return '后台已断开';
  // A `failed` detail reads `POST /look status <status> <code>`.
  const failed = code === 'failed' ? /^(\S+ \S+) status (\d+) (\S*)$/.exec(detailOf(e)) : null;
  const fault = failed && serverFaultText({ status: Number(failed[2]), code: failed[3], body: { route: failed[1] } });
  if (fault) return fault;
  const key = code === 'blocked' ? detailOf(e) : detailOf(e).split(' ').pop() ?? '';
  return LOOK_WHY[key] ?? '后台没有接受';
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

export const look = () => runOp('look', () => getBridge().app.look(), '正在识读前台窗口', (e) => `屏幕识读没有完成：${lookWhy(e)}`);

export const openQuickInput = () => runOp('quickInput', () => getBridge().app.openQuickInput(), '已打开快速输入', () => '快速输入没有打开');

export const stopSpeech = () =>
  runOp('stopSpeech', () => getBridge().avatar.stopSpeech(), '已停止说话', (e) => `没有停下：${codeOf(e) === 'failed' ? '角色没有连上' : '桌面角色没有回应'}`);
