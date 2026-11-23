// A due reminder's 延后 and 完成, as the desktop card and 今日 send them.
import { AgentdCallError, post, seg } from '../bridge/agentd';

/** POST /commitments/{id}/snooze; the reminder's new due time in epoch seconds. */
export const snoozeReminder = (id: string, minutes: number): Promise<number> =>
  post<{ commitment: { due_at: number } }>(`/commitments/${seg(id)}/snooze`, { minutes }).then((r) => r.commitment.due_at);

/** POST /commitments/{id}/complete. agentd marks a one-time reminder fulfilled when it announces it, so its
 *  `illegal_transition` is done too. */
export const completeReminder = (id: string): Promise<void> =>
  post(`/commitments/${seg(id)}/complete`).then(
    () => undefined,
    (e: unknown) => {
      if (!(e instanceof AgentdCallError && e.code === 'illegal_transition')) throw e;
    },
  );
