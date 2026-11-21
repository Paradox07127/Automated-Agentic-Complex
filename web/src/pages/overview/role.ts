import { isoToMs, type WireDiagState } from '../../domain';

/** The role band's live line, from /diag/state: what she looks at, what her body does, what observation reads. */
export interface RoleNow {
  /** Foreground app she reads. */
  app: string | null;
  /** Body behavior in words: 坐着, 走动 … */
  doing: string | null;
  /** Observation sources switched on, in words. */
  sources: string[];
  /** Last observation that came back. */
  last_at: number | null;
}

/** spatial.py TICK_TYPES and character_state.py DOING keys. */
const DOING: Readonly<Record<string, string>> = {
  idle: '待着',
  observe: '看着窗口',
  short_walk: '走动',
  sit: '坐着',
  sitting: '坐着',
  hold_window_edge: '扶着窗边',
  climb_window_top: '待在窗顶',
  relax: '放松',
  think: '想事情',
  wait: '等着',
  sleep: '睡觉',
};

const SOURCES: ReadonlyArray<[keyof WireDiagState['context']['sources'], string]> = [
  ['window_text', '窗口文字'],
  ['screenshots', '截图'],
  ['page_text', '浏览器'],
];

export function roleOf(d: Pick<WireDiagState, 'context' | 'behavior' | 'observation' | 'body'>): RoleNow {
  const run = d.behavior?.running?.[0]?.type ?? d.body?.activity ?? null;
  const ok = d.observation?.recent?.find((r) => r.state === 'ready');
  const src = d.context?.sources;
  return {
    app: d.context?.window?.app ?? null,
    doing: run == null ? null : (DOING[run] ?? null),
    sources: src ? SOURCES.filter(([k]) => src[k] === 'connected').map(([, v]) => v) : [],
    last_at: ok ? isoToMs(ok.at) : null,
  };
}
