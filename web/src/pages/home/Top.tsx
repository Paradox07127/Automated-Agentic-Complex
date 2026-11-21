import { useEffect, useState, type CSSProperties } from 'react';
import { getBridge } from '../../bridge';
import type { RuntimeChildState, RuntimeSnapshot } from '../../bridge/runtimeSnapshot';
import { Icon } from '../../ui';
import { Pip, type PipProps } from '../overview/Pip';
import type { Box } from './geometry';
import styles from './Top.module.css';

const at = (b: Box): CSSProperties => ({ left: b.left, top: b.top, width: b.width, height: b.height });

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
  return (
    <div className={styles.status} style={at(box)} role="group" aria-label="组件状态">
      {rows.map(([name, [tone, state]]) => (
        <span key={name} className={styles.item} data-tone={tone}>
          <b>{name}</b>
          <Pip tone={tone} label={state} />
        </span>
      ))}
    </div>
  );
}

/** CloseButtonNode: closes the window, as its close light does. */
export function CloseKey({ box }: { box: Box }) {
  return (
    <span className={styles.closeNode} style={at(box)}>
      <button type="button" className={styles.close} aria-label="关闭窗口" title="关闭窗口" onClick={() => window.close()}>
        <Icon name="close" size={14} />
      </button>
    </span>
  );
}
