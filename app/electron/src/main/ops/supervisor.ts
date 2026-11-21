// `supervisor.*`: the supervised processes' states and restarts: agentd and the avatar renderer.
import { execFileSync } from 'node:child_process';
import { stateText } from '../../common/agentd.ts';
import { BridgeFailure } from '../../common/bridge.ts';
import type { SlotState } from '../../common/runtime.ts';
import { CpuSampler } from './avatar.ts';
import type { Ops, OpsContext } from './context.ts';

/** A slot's state as text, `external` included. */
export function slotText(state: SlotState): string {
  return state.kind === 'external' ? 'external' : stateText(state);
}

/** protocol.ts `ProcessState`; CPU and memory are null when unread. */
export function processState(state: SlotState, pid: number | undefined,
  usage: { cpuPercent: number | null; memoryMB: number | null } = { cpuPercent: null, memoryMB: null }): Record<string, unknown> {
  return { state: slotText(state), pid: pid ?? null, backoff: state.kind === 'backoff' ? state.seconds : null, ...usage };
}

/** Memory as macOS's `ps -o rss=` gives it (resident KiB), in MB; null when gone or unreadable. */
export function psResidentMB(pid: number): number | null {
  let out: string;
  try {
    out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
  return /^\d+$/.test(out) ? Number(out) / 1024 : null;
}

export function supervisorOps(ctx: OpsContext): Ops {
  // One sampler per process across this surface's reads.
  const samplers = { agentd: new CpuSampler(), avatar: new CpuSampler(), tunnel: new CpuSampler() };
  const usage = (child: 'agentd' | 'avatar' | 'tunnel', pid: number | undefined) => {
    const share = samplers[child].sample(pid, pid === undefined || !ctx.cpuSeconds ? null : ctx.cpuSeconds(pid), performance.now() / 1000);
    return { cpuPercent: share === null ? null : share * 100,
      memoryMB: pid === undefined || (ctx.platform ?? 'mac') !== 'mac' ? null : psResidentMB(pid) };
  };
  return {
    'supervisor.state': () => {
      const agentd = ctx.supervisor?.pid(), avatar = ctx.supervisor?.avatarPid?.();
      const tunnel = ctx.supervisor?.tunnel?.() ?? null, tunnelPid = tunnel ? ctx.supervisor?.tunnelPid?.() : undefined;
      return {
        agentd: processState(ctx.supervisor?.state() ?? { kind: 'stopped' }, agentd, usage('agentd', agentd)),
        avatar: processState(ctx.supervisor?.avatar() ?? { kind: 'stopped' }, avatar, usage('avatar', avatar)),
        ...(tunnel && { tunnel: processState(tunnel, tunnelPid, usage('tunnel', tunnelPid)) }),
      };
    },
    'supervisor.restart': ([target]) => {
      if (target !== 'agentd' && target !== 'avatar' && target !== 'all') throw new BridgeFailure('invalid_args', 'supervisor target');
      if (!ctx.supervisor) throw new BridgeFailure('failed', '没有数据目录（配置出错）');
      if (target === 'avatar' && !ctx.supervisor.restartAvatar) throw new BridgeFailure('not_implemented', 'avatar');
      if (target !== 'avatar') ctx.supervisor.restart();
      if (target !== 'agentd') ctx.supervisor.restartAvatar?.();
      return null;
    },
  };
}
