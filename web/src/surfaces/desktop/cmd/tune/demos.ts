// Screenshot-able 镜头与动作 states: `stack.html#/cmd?mode=tune&demo=<name>` (plus `still=1`, `theme=light|dark`).
import { stackQuery } from '../../../stack/demos';

export interface TuneDemo {
  /** Start with the first action the package lacks selected. */
  missing?: boolean;
}

export const TUNE_DEMOS: Record<string, TuneDemo> = {
  tune: {},
  'tune-missing': { missing: true },
};

export function tuneDemo(): TuneDemo {
  return TUNE_DEMOS[stackQuery().get('demo') ?? ''] ?? {};
}
