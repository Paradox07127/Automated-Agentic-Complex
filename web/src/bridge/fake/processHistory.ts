import { NOW } from '../../mock/fixtures';
import type { ProcessReading } from '../protocol';

/** The shell's last 30 minutes of readings, one every 10 s, around `cpu` and `mem` and ending at the demo clock. */
export function fakeHistory(cpu: number, mem: number): ProcessReading[] {
  return Array.from({ length: 180 }, (_, i) => ({
    at: NOW - (179 - i) * 10_000,
    cpuPercent: Math.round(cpu * (1 + Math.sin(i / 7) * 0.2) * 10) / 10,
    memoryMB: Math.round(mem * (1 + Math.sin(i / 23) * 0.02)),
  }));
}
