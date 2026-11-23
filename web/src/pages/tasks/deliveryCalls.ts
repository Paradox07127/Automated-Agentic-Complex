// The delivery receipts the task page and the chat send: shown, viewed, an artifact opened.
import { post, seg } from '../../bridge/agentd';
import { deliveryReceipt, fromDelivery, type Delivery, type WireDelivery } from '../../domain';

/** POST /agent/deliveries/{id}/(presented|viewed); resolves with the reply's delivery (its revision is one higher). */
export async function sendReceipt(d: Delivery, kind: 'presented' | 'viewed'): Promise<Delivery> {
  const body = deliveryReceipt(d);
  const r =
    kind === 'presented'
      ? await post<{ delivery: WireDelivery }>(`/agent/deliveries/${seg(d.id)}/presented`, body)
      : await post<{ delivery: WireDelivery }>(`/agent/deliveries/${seg(d.id)}/viewed`, body);
  return fromDelivery(r.delivery);
}

/**
 * POST /agent/deliveries/{id}/opened for the file at `path` (absolute or as the delivery lists it) in the task's newest
 * delivery listing it; false when none does, as for a file the run only changed.
 */
export async function sendOpened(deliveries: readonly Delivery[], taskId: string, path: string): Promise<boolean> {
  const of = (d: Delivery) => d.artifacts.find((a) => a.absolute_path === path || a.path === path);
  const d = deliveries.filter((x) => x.task_id === taskId && of(x)).sort((x, y) => y.version - x.version)[0];
  if (!d) return false;
  await post(`/agent/deliveries/${seg(d.id)}/opened`, { artifact_id: of(d)!.artifact_id });
  return true;
}
