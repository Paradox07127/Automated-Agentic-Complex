import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { playOnce, tokenMs } from './motion';
import styles from './GlitchIn.module.css';

/** 入场故障抖动：每步一帧（dur-g-flicker-step）的 steps 切片 + 横向错位 + 闪烁，只在挂载时跑一次，不循环。 */
export interface GlitchInProps {
  /** 步数，默认 8 */
  steps?: number;
  /** 最大横向错位 px，默认 6 */
  jitter?: number;
  /** 切片的随机种子，同一种子每次一样 */
  seed?: number;
  /** 延迟 ms */
  delay?: number;
  children: ReactNode;
}

/** mulberry32: a small deterministic generator, so a glitch looks the same every run. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function glitchFrames(steps: number, jitter: number, seed: number): Keyframe[] {
  const r = random(seed);
  const frames: Keyframe[] = [];
  for (let i = 0; i < steps; i += 1) {
    const top = Math.round(r() * 70);
    const band = 10 + Math.round(r() * 40);
    const x = Math.round((r() * 2 - 1) * jitter);
    frames.push({
      offset: i / steps,
      easing: 'steps(1, end)',
      clipPath: i % 3 === 2 ? 'inset(0 0 0 0)' : `inset(${top}% 0 ${Math.max(0, 100 - top - band)}% 0)`,
      translate: `${x}px 0`,
      opacity: i === 0 ? 0 : r() < 0.3 ? 0.4 : 1,
    });
  }
  frames.push({ offset: 1, clipPath: 'inset(0 0 0 0)', translate: '0px 0', opacity: 1 });
  return frames;
}

export function GlitchIn({ steps = 8, jitter = 6, seed = 7, delay = 0, children }: GlitchInProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = playOnce(el, glitchFrames(steps, jitter, seed), { duration: steps * tokenMs(el, 'dur-g-flicker-step', 17), delay });
    return () => a?.cancel();
  }, [steps, jitter, seed, delay]);
  return (
    <div ref={ref} className={styles.glitch} data-stub="GlitchIn">
      {children}
    </div>
  );
}

const Title = () => (
  <div className={styles.demoTitle}>
    <span className={styles.demoBar} />
    任务面板
  </div>
);

export const GlitchInDemos: Array<{ name: string; props: GlitchInProps }> = [
  { name: 'title', props: { children: <Title /> } },
  { name: 'long', props: { steps: 14, jitter: 10, seed: 3, children: <Title /> } },
];
