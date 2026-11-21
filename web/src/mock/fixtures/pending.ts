import type { PendingItem } from '../../domain';
import { APPROVALS } from './approvals';
import { REVIEWS } from './deliveries';
import { QUESTIONS } from './questions';

/** The single PENDING list: overview 01, tasks › 待处理 and the desktop stack all sort this with `sortPending`. */
export const PENDING: PendingItem[] = [...QUESTIONS, ...APPROVALS, ...REVIEWS];
