import type { Question } from '../../domain';
import { fromInteraction } from '../../domain/adapt';
import { NOW } from './clock';
import { WIRE_INTERACTIONS } from './wire/work';

/** `/agent/interactions` requests read at NOW. Q1 has no deadline, so cards show「不限时 · 等了 4 分钟」. */
export const QUESTIONS: Question[] = WIRE_INTERACTIONS.map((q) => fromInteraction(q, NOW));
