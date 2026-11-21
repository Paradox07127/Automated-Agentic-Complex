// What a card can ask the desktop panels to do; useStackActions carries each one out through the bridge.
import type { NavTarget } from '../../shell/nav';

/** The delivery a review card decides on, as the accept / reject request names it. */
export interface DeliveryRef {
  task_id: string;
  delivery_id: string;
  expected_revision: number;
  generation: number;
}

export type CardAction =
  | { type: 'decide'; id: string; decision: 'allow' | 'deny' | 'allow_session'; generation: number; mode?: string }
  | { type: 'answer'; id: string; expected_version: number; answers: Record<string, string[]>; text: string }
  | { type: 'cancel-question'; id: string; expected_version: number }
  | ({ type: 'accept'; id: string } & DeliveryRef)
  | ({ type: 'reject'; id: string; note: string } & DeliveryRef)
  | { type: 'collapse'; id: string }
  | { type: 'dismiss'; id: string }
  | { type: 'archive'; id: string }
  | { type: 'snooze'; id: string; commitment: string; minutes: 5 | 15 | 60 }
  | { type: 'complete'; id: string; commitment: string }
  /** Opens the main window at a target (shell/nav.ts). */
  | { type: 'open'; to: NavTarget; message: string }
  | { type: 'jump-terminal'; sessionId: string }
  /** A session card: its own session in the main window's session panel, an external one in its terminal. */
  | { type: 'open-session'; sessionId: string; title: string }
  | { type: 'copy'; text: string }
  | { type: 'reveal'; path: string }
  | { type: 'run-in-terminal'; command: string };

export type Act = (a: CardAction) => void;

/** Same wording as the chat page's cancel receipt. */
export const CANCEL_RECEIPT = '已取消这次提问';

/** Seconds a cancel receipt can still be undone before it is sent. */
export const UNDO_S = 5;
