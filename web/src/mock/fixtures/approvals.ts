import type { Approval } from '../../domain';
import { fromApproval } from '../../domain/adapt';
import { NOW } from './clock';
import { WIRE_APPROVALS } from './wire/work';

/**
 * `/approvals` read at NOW (approvals.py:56-74, window ≤ 55 s per card). Main window, overview and the desktop
 * stack all read this one list; order is deliberately mixed, `sortPending` orders it.
 */
export const APPROVALS: Approval[] = WIRE_APPROVALS.map((a) => fromApproval(a, NOW));
