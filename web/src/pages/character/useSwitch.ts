import { useState } from 'react';
import { getBridge, type BridgeError } from '../../bridge';
import type { CharacterProfile } from '../../domain';
import { SWITCH_STAGES } from './tables';
import { hostReason, NO_REASON } from './labels';

export type SwitchState =
  | { phase: 'idle' }
  | { phase: 'running'; target: CharacterProfile }
  /** `stage` indexes SWITCH_STAGES; null when the shell did not get as far as a stage. */
  | { phase: 'failed'; target: CharacterProfile; stage: number | null; reason: string };

export interface SwitchOptions {
  initial: SwitchState;
  /** Non-external tasks still running: switching pauses input, so ask first. */
  runningTasks: () => Promise<ReadonlyArray<{ title: string }>>;
  ask: (spec: { title: string; note: string; confirmLabel: string; cancelLabel: string; onConfirm: () => void }) => void;
  onDone: (target: CharacterProfile) => void;
}

const REFUSED: Record<string, string> = { not_implemented: '这个版本还不能从这里切换角色', unavailable: '角色还没连上' };
const refused = (e: unknown): string => REFUSED[(e as Partial<BridgeError> | null)?.code ?? ''] ?? NO_REASON;

/** Switch flow: confirm, call the shell's switch, stop at the stage it names, retry the same target. */
export function useSwitch(o: SwitchOptions) {
  const [state, setState] = useState<SwitchState>(o.initial);

  const start = (target: CharacterProfile) => {
    setState({ phase: 'running', target });
    getBridge()
      .character.switchTo(target.id)
      .then((r) => {
        if (!r.ok) setState({ phase: 'failed', target, stage: SWITCH_STAGES.indexOf(r.stage), reason: hostReason(r.reason) });
        else {
          setState({ phase: 'idle' });
          o.onDone(target);
        }
      })
      .catch((e: unknown) => setState({ phase: 'failed', target, stage: null, reason: refused(e) }));
  };

  const confirm = (target: CharacterProfile, note: string) =>
    o.ask({ title: `切换到 ${target.name}？`, note, confirmLabel: '切换', cancelLabel: '先不切换', onConfirm: () => start(target) });

  /** Always confirms; the note names the tasks that keep running while input pauses. */
  const request = (target: CharacterProfile, current: string, currentName = '当前角色') => {
    if (target.id === current || state.phase === 'running') return;
    const swap = `${currentName} 先从桌面隐藏，资源加载完成后显示 ${target.name}。切换期间约 2 秒不接受输入。`;
    o.runningTasks().then(
      (tasks) => confirm(target, tasks.length === 0 ? swap : `${swap}现在有 ${tasks.length} 个任务在跑（${tasks.map((t) => t.title).join('、')}），任务不会停。`),
      () => confirm(target, `${swap}没读到任务列表。`),
    );
  };

  return {
    state,
    request,
    /** 「重试」 runs the same switch again. */
    retry: () => state.phase === 'failed' && start(state.target),
    dismiss: () => setState({ phase: 'idle' }),
    /** Opens a URL demo state directly. */
    set: setState,
  };
}
