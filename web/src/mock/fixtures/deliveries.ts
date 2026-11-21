import type { Delivery, Review } from '../../domain';
import { fromDelivery } from '../../domain/adapt';
import { WIRE_DELIVERIES } from './wire/work';

/** `personal_deliveries`. Timestamps only move forward: produced ≤ presented ≤ viewed ≤ decided. */
export const DELIVERIES: Delivery[] = WIRE_DELIVERIES.map(fromDelivery);

/** Deliveries still waiting for accept / reject (produced, presented or viewed). */
export const REVIEWS: Review[] = DELIVERIES.filter((d) => d.decided_at === null).map((d) => ({
  id: `r-${d.id}`,
  kind: 'review',
  task_id: d.task_id,
  delivery_id: d.id,
  revision: d.revision,
  generation: d.generation,
  title: `${d.title} v${d.version}`,
  source: `角色任务 │ ${d.title}`,
  since: d.presented_at ?? d.produced_at,
  verification_source: d.verification_source,
}));
