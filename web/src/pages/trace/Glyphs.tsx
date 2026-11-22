// The page's own drawn marks: state shapes, log level shapes and the step icons the shared icon set has no match for.
import type { LogLevel } from '../../bridge/logs';
import type { Shape } from './data';
import type { StepIcon } from './steps';

const SHAPE: Readonly<Record<Shape, string>> = {
  ok: 'M1 6.4l1.4-1.4L4.8 7.4 9.6 2.6 11 4l-6.2 6.2z',
  fail: 'M0 0h12v12H0zM3.2 2.2L6 5 8.8 2.2l1 1L7 6l2.8 2.8-1 1L6 7 3.2 9.8l-1-1L5 6 2.2 3.2z',
  cut: 'M2 1h3v10H2zM7 1h3v10H7z',
  run: 'M6 0a6 6 0 1 1-6 6h2a4 4 0 1 0 4-4z',
  wait: 'M6 0l6 6-6 6-6-6z',
  skip: 'M1 5h10v2H1z',
  text: 'M1 1h10v10H1zM2.6 2.6v6.8h6.8V2.6z',
  unk: 'M6 1l5.5 10H.5zM6 3.9L3 9.4h6z',
};

export function ShapeMark({ s }: { s: Shape }) {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" data-shape={s}>
      <path d={SHAPE[s]} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

const LEVEL: Readonly<Record<LogLevel, string>> = {
  err: 'M1.4 0L5 3.6 8.6 0 10 1.4 6.4 5 10 8.6 8.6 10 5 6.4 1.4 10 0 8.6 3.6 5 0 1.4z',
  warn: 'M5 0l5 10H0z',
  info: 'M5 2.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2z',
  dbg: 'M2 2h6v6H2zM3.2 3.2v3.6h3.6V3.2z',
};

export function LevelMark({ l }: { l: LogLevel }) {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path d={LEVEL[l]} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

const STEP: Readonly<Record<StepIcon, string>> = {
  in: 'M10 2h4v8h4l-6 6-6-6h4zM2 14h5l2 3h6l2-3h5v8H2z',
  ctx: 'M12 2l10 5-10 5L2 7zM4.4 10.8L12 14.6l7.6-3.8L22 12l-10 5-10-5zM4.4 15.8L12 19.6l7.6-3.8L22 17l-10 5-10-5z',
  judge: 'M11 2h2v3h7v2h-1.2l2.7 7a4 4 0 0 1-7 0L17.2 7H13v13h5v2H6v-2h5V7H6.8l2.7 7a4 4 0 0 1-7 0L5.2 7H4V5h7zM6 9.6L4.6 13.5h2.8zM18 9.6l-1.4 3.9h2.8z',
  kernel: 'M6 6h12v12H6zM9 9v6h6V9zM8 2h2v3H8zM14 2h2v3h-2zM8 19h2v3H8zM14 19h2v3h-2zM2 8h3v2H2zM2 14h3v2H2zM19 8h3v2h-3zM19 14h3v2h-3z',
  tool: 'M21 6.5a5 5 0 0 1-6.6 4.7L6 19.6 3.4 17l8.4-8.4A5 5 0 0 1 17.5 2L14.5 5l1 3.5 3.5 1z',
  shield: 'M12 1l9 4v6c0 6-4 10.5-9 12-5-1.5-9-6-9-12V5zM10.6 15.8l6.2-6.2-1.6-1.6-4.6 4.6-2-2-1.6 1.6z',
  say: 'M3 3h18v13H10l-5 4v-4H3z',
  voice: 'M3 9h4l5-5v16l-5-5H3zM15 7.5a6 6 0 0 1 0 9l-1.5-1.5a4 4 0 0 0 0-6zM18 4.5a10 10 0 0 1 0 15L16.6 18a8 8 0 0 0 0-12z',
  motion: 'M13 1.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM10 8h5l3 5-2 1-2-3-1 4 3 7h-3l-2-5-2 5H6l3-8-1-3-3 2-1-2z',
};

export function StepMark({ i }: { i: StepIcon }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d={STEP[i]} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

/** A memory chip's diamond. */
export function MemMark() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
      <path d="M12 1.5L22.5 12 12 22.5 1.5 12zM12 6.5L6.5 12l5.5 5.5 5.5-5.5zM12 9.5L14.5 12 12 14.5 9.5 12z" fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

/** The source filters' funnel. */
export function FunnelMark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path d="M2 3h20l-8 9v8l-4 2V12z" fill="currentColor" />
    </svg>
  );
}
