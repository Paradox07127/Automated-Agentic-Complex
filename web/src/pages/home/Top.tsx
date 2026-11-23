import { useEffect, useState } from 'react';
import { getBridge } from '../../bridge';
import type { RuntimeChildState, RuntimeSnapshot } from '../../bridge/runtimeSnapshot';
import { StatusLamp, StatusRow } from '../../ui/game';
import type { Box } from './geometry';

/** The shell's runtime snapshot, kept current; null until read, and on a host without app.runtime. */
function useRuntime(): RuntimeSnapshot | null {
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  useEffect(() => {
    const bridge = getBridge();
    let live = true;
    bridge.app.runtime().then(
      (r) => live && setRuntime((prev) => prev ?? r),
      () => {},
    );
    const off = bridge.app.onRuntime(setRuntime);
    return () => {
      live = false;
      off();
    };
  }, []);
  return runtime;
}

/** The lamp's state for each component state: ✓ runs, □ waits, ■ failed, • idle. */
type Lamp = 'ok' | 'paused' | 'failed' | 'idle';

const PROCESS: Record<RuntimeChildState, [Lamp, string]> = {
  running: ['ok', '运行中'],
  external: ['ok', '外部运行'],
  starting: ['idle', '启动中'],
  backoff: ['paused', '等待重启'],
  gpu_hold: ['paused', '等待显卡'],
  port_in_use: ['failed', '端口占用'],
  failed: ['failed', '失败'],
  stopped: ['idle', '未运行'],
};

const TTS: Record<RuntimeSnapshot['tts']['state'], [Lamp, string]> = {
  ready: ['ok', '就绪'],
  probing: ['idle', '检测中'],
  unknown: ['idle', '检测中'],
  cold: ['paused', '待唤醒'],
  unreachable: ['failed', '连不上'],
  off: ['idle', '未配置'],
};

/** What the page's own reads of agentd say. */
export type Conn = 'loading' | 'failed' | 'refused' | 'lost' | 'stale' | 'ok';

const CONN: Record<Conn, [Lamp, string]> = {
  loading: ['idle', '读取中'],
  failed: ['failed', '读取失败'],
  refused: ['failed', '拒绝访问'],
  lost: ['failed', '未接入'],
  stale: ['failed', '刷新失败'],
  ok: ['ok', '已连接'],
};

/** 后台: the process's state, unless it runs and the page's reads of it are not through. */
function backend(state: RuntimeChildState | undefined, conn: Conn): [Lamp, string] {
  if (state && state !== 'running' && state !== 'external') return PROCESS[state];
  return conn !== 'ok' || !state ? CONN[conn] : PROCESS[state];
}

/** The components the shell runs, each with its state, across the top of the watch; without app.runtime, 后台 alone. */
export function Status({ box, conn }: { box: Box; conn: Conn }) {
  const rt = useRuntime();
  const rows: Array<[string, [Lamp, string]]> = [['后台', backend(rt?.processes.agentd.state, conn)]];
  if (rt) rows.push(['角色', PROCESS[rt.processes.avatar.state]], ['语音', TTS[rt.tts.state]]);
  return <StatusRow box={box} items={rows.map(([name, [tone, state]]) => ({ name, failed: tone === 'failed', state: <StatusLamp size="sm" state={tone} label={state} /> }))} />;
}
