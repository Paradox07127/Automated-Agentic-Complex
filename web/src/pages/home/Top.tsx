import { useEffect, useState } from 'react';
import { getBridge } from '../../bridge';
import type { RuntimeChildState, RuntimeSnapshot } from '../../bridge/runtimeSnapshot';
import { StatusRow } from '../../ui/game';
import { Pip, type PipProps } from '../overview/Pip';
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

const PROCESS: Record<RuntimeChildState, [PipProps['tone'], string]> = {
  running: ['ok', '运行中'],
  external: ['ok', '外部运行'],
  starting: ['idle', '启动中'],
  backoff: ['paused', '等待重启'],
  gpu_hold: ['paused', '等待显卡'],
  port_in_use: ['failed', '端口占用'],
  failed: ['failed', '失败'],
  stopped: ['idle', '未运行'],
};

const TTS: Record<RuntimeSnapshot['tts']['state'], [PipProps['tone'], string]> = {
  ready: ['ok', '就绪'],
  probing: ['idle', '检测中'],
  unknown: ['idle', '检测中'],
  cold: ['paused', '待唤醒'],
  unreachable: ['failed', '连不上'],
  off: ['idle', '未配置'],
};

/** The components the shell runs, each with its state, across the top of the watch. */
export function Status({ box }: { box: Box }) {
  const rt = useRuntime();
  if (!rt) return null;
  const rows: Array<[string, [PipProps['tone'], string]]> = [
    ['后台', PROCESS[rt.processes.agentd.state]],
    ['角色', PROCESS[rt.processes.avatar.state]],
    ['语音', TTS[rt.tts.state]],
  ];
  return <StatusRow box={box} items={rows.map(([name, [tone, state]]) => ({ name, failed: tone === 'failed', state: <Pip tone={tone} label={state} /> }))} />;
}
