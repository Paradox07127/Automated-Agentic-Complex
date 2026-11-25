import { useLayoutEffect, type RefObject } from 'react';
import type { AvatarAction } from '../../bridge';
import { useCompactScene } from './compact';
import type { Toast } from './feedback';
import type { Pane } from './Operator';
import type { Side } from './Side';

/** What the page under the scene lays the room out by: the stage's action bar and the compact layout. */
export interface SceneReport {
  deck: boolean;
  compact: boolean;
}

/** Detail panel width per view (BRIEF 11-22 C): wide for 外观, 动作 and 编排 (and 导入 under them), narrow for 设定. */
export const PANEL: Record<Exclude<Pane, 'overview'> | Side['of'], 'wide' | 'narrow'> = {
  motion: 'wide',
  chain: 'wide',
  look: 'wide',
  import: 'wide',
  set: 'narrow',
};

/** First motion worth showing: not required, playable, present. */
export const firstPick = (actions: AvatarAction[]) => actions.find((a) => !a.requiredReason && a.playable !== false && !a.missing)?.id ?? actions[0]?.id ?? '';

export const failed = (what: string, toast: Toast) => (e: unknown) => {
  const code = (e as { code?: string } | null)?.code;
  toast(`${what}没有完成：${code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' });
};

/** Tells `report` the drawn scene's deck and whether `scene` is compact, before paint so the room moves with the stage. */
export function useSceneReport(scene: RefObject<HTMLElement | null>, deck: boolean, report: ((s: SceneReport) => void) | undefined) {
  const compact = useCompactScene(scene);
  useLayoutEffect(() => report?.({ deck, compact }), [deck, compact, report]);
}
