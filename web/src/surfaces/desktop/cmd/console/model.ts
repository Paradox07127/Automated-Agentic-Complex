// What the menu bar popover reads: agentd's `/desktop/presence` (her line, the first thing waiting) and the shell's runtime
// snapshot (the component status row).
import { useEffect, useState } from 'react';
import { getBridge, type ProcessState, type RecentAnnouncement } from '../../../../bridge';
import type { RuntimeChildState, RuntimeSnapshot } from '../../../../bridge/runtimeSnapshot';
import { voiceText } from '../../../../domain/voiceState';
import { pendingCount } from '../actions';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** What waits on the user, as the popover's row says it: the first one's kind and title, and how many in all. */
export interface Waiting {
  kind: string;
  title: string;
  total: number;
}

/** Approvals first, then her questions, then results to look at (the order the brief's 待处理 decides them in). */
const KINDS: ReadonlyArray<[string, string]> = [['approvals', '待批准'], ['questions', '待回答'], ['results', '待复核']];

export function waitingOf(presence: unknown): Waiting | null {
  const pending = obj(obj(presence)?.pending);
  const total = pendingCount(presence);
  if (!pending || total === 0) return null;
  for (const [key, kind] of KINDS) {
    const rows = pending[key];
    const first = Array.isArray(rows) ? str(obj(rows[0])?.title) : null;
    if (first) return { kind, title: first, total };
  }
  return { kind: '待处理', title: `${total} 项待处理`, total };
}

/** Her line on the card: agentd's `role.doing`; null without one. */
export function doingOf(presence: unknown): string | null {
  return str(obj(obj(presence)?.role)?.doing);
}

/** The shell's runtime snapshot, kept current; null until read. */
export function useRuntime(): RuntimeSnapshot | null {
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

/** 最近播报's rows as native keeps them; empty until pushed. */
export function useRecent(): RecentAnnouncement[] {
  const [rows, setRows] = useState<RecentAnnouncement[]>([]);
  useEffect(() => getBridge().desktop.onRecent(setRows), []);
  return rows;
}

/** StatusLamp's state for a cell; a failed cell draws as the panels' unplugged mark instead. */
type Tone = 'ok' | 'paused' | 'failed' | 'idle';

const PROCESS: Record<RuntimeChildState, [Tone, string]> = {
  running: ['ok', '运行中'],
  external: ['ok', '外部运行'],
  starting: ['idle', '启动中'],
  backoff: ['paused', '等待重启'],
  port_in_use: ['failed', '端口占用'],
  failed: ['failed', '无响应'],
  stopped: ['idle', '未运行'],
};

const TTS_TONE: Record<RuntimeSnapshot['tts']['state'], Tone> = { ready: 'ok', probing: 'idle', unknown: 'idle', cold: 'paused', unreachable: 'failed', off: 'idle' };

/** The helper's states that are trouble; the others leave it off the row. */
const HELPER: Readonly<Record<string, [Tone, string]>> = { failed: ['failed', '失败'], port_in_use: ['failed', '端口占用'] };

export interface StatusCell {
  name: string;
  tone: Tone;
  label: string;
}

/** 后台, 角色 and 语音, as the home page's row; 助手 only while the platform helper is in trouble. `agentdDown` stands the
 *  service in as unanswering. */
export function statusCells(rt: RuntimeSnapshot | null, helper: ProcessState | null | undefined, agentdDown: boolean): StatusCell[] {
  if (!rt) return [];
  const cell = (name: string, [tone, label]: [Tone, string]): StatusCell => ({ name, tone, label });
  const helperState = helper && (HELPER[helper.state] ?? (helper.state.startsWith('backoff') ? (['paused', '重连中'] as [Tone, string]) : null));
  return [
    cell('后台', agentdDown ? PROCESS.failed : PROCESS[rt.processes.agentd.state]),
    cell('角色', PROCESS[rt.processes.avatar.state]),
    cell('语音', [TTS_TONE[rt.tts.state], voiceText(rt.tts.state, rt.tts.retry_after_s, rt.tts.reason)]),
    ...(helperState ? [cell('助手', helperState)] : []),
  ];
}
