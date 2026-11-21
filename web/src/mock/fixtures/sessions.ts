import type { Session } from '../../domain';
import { fromSession } from '../../domain/adapt';
import { at } from './clock';
import { WIRE_SESSIONS } from './wire/work';

/** `/sessions`. Overview writes「3 个会话 · 运行 1 · 等批准 1 · 空闲 1」for the ext ones. */
export const SESSIONS: Session[] = WIRE_SESSIONS.map(fromSession);

/** Presence role line (desktop_presence.py:63-68), mirrors the foreground run of T1. */
export const PRESENCE_ROLE = { state: 'running_tool' as const, phase: 'tool_started' as const, run_id: 'run-8d03', since: at(14, 31, 30) };

/** Pause / quiet windows in ms, from `GET /state` observation (WIRE_OBSERVATION); null when not active. Demos set them. */
export const PAUSE = { paused_until: null as number | null, quiet_until: null as number | null };

/** Reminders (`/commitments`); distinct from presence reminders which stay 0. */
export const REMINDERS: Array<{ id: string; title: string; due_at: number }> = [
  { id: 'rm1', title: '交报销单', due_at: at(15, 0) },
  { id: 'rm2', title: '周会', due_at: at(16, 30) },
];
