import { useEffect, useRef, useState } from 'react';
import { sayMs } from './sayTime';

/** A line or thought paused past its time gets at least this long once resumed. */
export const RESUME_MS = 1500;

export interface CollapseTarget {
  kind: 'line' | 'thought';
  key: string;
  text: string;
}

export interface CollapseTimer {
  key: string;
  ms: number;
  total: number;
  paused: boolean;
}

/**
 * Counts down `sayMs(text)` for the active finished line or thought and collapses the bubble to an icon at zero.
 * Pauses while hovered or while quick input is open; after a pause at least `RESUME_MS` remain.
 */
export function useCollapse(target: CollapseTarget | null, still: boolean, paused: boolean) {
  const [run, setRun] = useState(0);
  const [collapsedToken, setCollapsedToken] = useState<string | null>(null);
  const token = target ? `${target.key}#${run}` : null;
  const text = target?.text ?? '';
  const collapsed = token != null && collapsedToken === token;

  const slot = useRef<{ token: string; ms: number; total: number; resumes: number }>({ token: '', ms: 0, total: 0, resumes: 0 });
  if (!token) {
    slot.current = { token: '', ms: 0, total: 0, resumes: 0 };
  } else if (slot.current.token !== token) {
    const total = sayMs(text);
    slot.current = { token, ms: total, total, resumes: 0 };
  }

  useEffect(() => {
    setCollapsedToken((prev) => (prev === token ? prev : null));
  }, [token]);

  useEffect(() => {
    if (!token || collapsed || still || paused) return;
    if (slot.current.token !== token) {
      const total = sayMs(text);
      slot.current = { token, ms: total, total, resumes: 0 };
    }
    const cur = slot.current;
    const start = Date.now();
    const t = setTimeout(() => setCollapsedToken(token), cur.ms);
    return () => {
      clearTimeout(t);
      cur.ms = Math.max(RESUME_MS, cur.ms - (Date.now() - start));
      cur.resumes += 1;
    };
  }, [token, text, collapsed, still, paused]);

  const timer: CollapseTimer | null =
    token && !collapsed ? { key: `${token}:${slot.current.resumes}`, ms: slot.current.ms, total: slot.current.total, paused } : null;

  return {
    collapsed,
    timer,
    expand: () => {
      setCollapsedToken(null);
      setRun((r) => r + 1);
    },
  };
}
