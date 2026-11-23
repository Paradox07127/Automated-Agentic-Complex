// `supervisor.*`: the supervised processes' states and restarts: agentd and the avatar renderer; the states also of the
// `ssh` and `local` services.
import { execFileSync } from 'node:child_process';
import { stateText } from '../../common/agentd.ts';
import { BridgeFailure } from '../../common/bridge.ts';
import { SERVICE_IDS, type ServiceId } from '../../common/config.ts';
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

export type ProcessChild = 'agentd' | 'avatar' | ServiceId;
/** What ProcessHistory and supervisor.state read: OpsContext's processes, CPU reader and platform. */
interface UsagePorts {
  supervisor?: Pick<NonNullable<OpsContext['supervisor']>, 'state' | 'pid' | 'avatar' | 'avatarPid'> | null;
  services?: Pick<NonNullable<OpsContext['services']>, 'view'> | null;
  cpuSeconds?: OpsContext['cpuSeconds'];
  platform?: OpsContext['platform'];
}

/** agentd, the renderer and the services that have a state, in supervisor.state's order. */
function supervised(ctx: UsagePorts): [ProcessChild, SlotState, number | undefined][] {
  const services = SERVICE_IDS.flatMap((id): [ProcessChild, SlotState, number | undefined][] => {
    const v = ctx.services?.view(id);
    return !v || v.state === null ? [] : [[id, v.state, v.pid ?? undefined]];
  });
  return [['agentd', ctx.supervisor?.state() ?? { kind: 'stopped' }, ctx.supervisor?.pid()],
    ['avatar', ctx.supervisor?.avatar() ?? { kind: 'stopped' }, ctx.supervisor?.avatarPid?.()], ...services];
}

/** CPU (percent of one core since the sampler's last read) and memory of `pid`; memory only on macOS. */
function usageOf(ctx: UsagePorts, sampler: CpuSampler, pid: number | undefined): { cpuPercent: number | null; memoryMB: number | null } {
  const share = sampler.sample(pid, pid === undefined || !ctx.cpuSeconds ? null : ctx.cpuSeconds(pid), performance.now() / 1000);
  return { cpuPercent: share === null ? null : share * 100,
    memoryMB: pid === undefined || (ctx.platform ?? 'mac') !== 'mac' ? null : psResidentMB(pid) };
}

/** protocol.ts `ProcessReading`; `at` in ms since the epoch. */
export interface ProcessReading { at: number; cpuPercent: number | null; memoryMB: number | null }

/** ProcessHistory reads every 10 s and keeps 180 readings per process: the last 30 minutes. */
export const HISTORY_EVERY_MS = 10_000;
export const HISTORY_KEEP = 180;

/** Each supervised process's readings at a fixed interval while the shell runs; past `keep` the oldest is overwritten. */
export class ProcessHistory {
  private readonly rings = new Map<ProcessChild, { items: ProcessReading[]; next: number }>();
  private readonly samplers = new Map<ProcessChild, CpuSampler>();
  private readonly ctx: UsagePorts;
  private readonly keep: number;

  constructor(ctx: UsagePorts, keep = HISTORY_KEEP) {
    this.ctx = ctx;
    this.keep = keep;
  }

  /** One reading of every supervised process; one not running reads null. */
  sample(at = Date.now()): void {
    for (const [child, , pid] of supervised(this.ctx)) {
      let sampler = this.samplers.get(child);
      if (!sampler) this.samplers.set(child, sampler = new CpuSampler());
      let ring = this.rings.get(child);
      if (!ring) this.rings.set(child, ring = { items: [], next: 0 });
      const reading = { at, ...usageOf(this.ctx, sampler, pid) };
      if (ring.items.length < this.keep) ring.items.push(reading);
      else ring.items[ring.next] = reading;
      ring.next = (ring.next + 1) % this.keep;
    }
  }

  /** `child`'s readings, oldest first. */
  of(child: ProcessChild): ProcessReading[] {
    const ring = this.rings.get(child);
    return ring ? [...ring.items.slice(ring.next), ...ring.items.slice(0, ring.next)] : [];
  }

  /** Reads every `every` ms until the returned stop; the timer does not keep the process alive. */
  start(every = HISTORY_EVERY_MS): () => void {
    const timer = setInterval(() => this.sample(), every);
    timer.unref();
    return () => clearInterval(timer);
  }
}

export function supervisorOps(ctx: OpsContext): Ops {
  // One sampler per process across this surface's reads.
  const samplers = { agentd: new CpuSampler(), avatar: new CpuSampler(), tts: new CpuSampler(), motion: new CpuSampler(), llm: new CpuSampler() };
  return {
    'supervisor.state': () => Object.fromEntries(supervised(ctx).map(([child, state, pid]) =>
      [child, { ...processState(state, pid, usageOf(ctx, samplers[child], pid)), history: ctx.processHistory?.of(child) ?? [] }])),
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
