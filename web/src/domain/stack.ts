// Desktop floating-card stack data. The shell pushes `StackPayload` through `bridge.stack.onCards`;
// it converts times to epoch ms before pushing, and review / delivery cards carry the delivery's revision and generation.
import type { CanonicalTaskId, TaskKey } from './ids';
import type { VerificationSource } from './states';
import type { Approval, Delivery, Question, Review } from './work';

/** A coding task waiting for review (`GET /tasks` needs_review, target ≠ character). It has no delivery: native settles it at `/tasks/:id/accept|reject`. */
export interface CodingReview {
  id: string;
  kind: 'review';
  task_id: CanonicalTaskId;
  title: string;
  /** "Codex · 修 HostLink 断线重连" style origin line. */
  source: string;
  since: number;
  cwd: string | null;
  verification_source: VerificationSource;
}

/** Receipt after a decision, including one taken elsewhere ("已在终端批准 · hh:mm"). */
export interface ApprovalOutcome {
  kind: 'approved' | 'denied' | 'expired' | 'failed' | 'elsewhere';
  at: number;
  text?: string;
}

interface CardBase {
  id: string;
  /** When the card arrived (epoch ms on the stack clock). */
  at: number;
  /** Folded into the queue bar; still counted as waiting. */
  collapsed?: boolean;
  /** In-place receipt shown for a moment before the card leaves (「已回答：包含」). */
  receipt?: string;
}

/** `done` / `brief` come from feed announces; `resume` follows a role-approval answer that agentd saved with `resume_required`. */
export type NoticeVariant = 'reminder' | 'look' | 'done' | 'brief' | 'resume';

export type StackCard =
  | (CardBase & {
      kind: 'approval';
      item: Approval;
      outcome?: ApprovalOutcome | null;
      /** [会话 ↗] opens the task, or jumps to the terminal for external sessions. */
      session: 'task' | 'terminal';
      /** The task [会话 ↗] opens: approvals carry none, so it comes from the approval's own session. */
      task_id?: TaskKey | null;
    })
  /** `item.interaction_kind === 'approval'` is a role approval: every question is answered 允许 or 拒绝. */
  | (CardBase & { kind: 'question'; item: Question; outcome?: ApprovalOutcome | null })
  | (CardBase & { kind: 'review'; source: 'delivery'; item: Review; delivery: Delivery; summary: string; lifeS: number; lifeTotalS: number })
  | (CardBase & { kind: 'review'; source: 'coding'; item: CodingReview; summary: string })
  | (CardBase & { kind: 'delivery'; delivery: Delivery; title: string; summary: string; lifeS: number; lifeTotalS: number })
  | (CardBase & { kind: 'error'; task_id: string; title: string; reason: string })
  | (CardBase & {
      kind: 'notice';
      variant: NoticeVariant;
      title: string;
      body?: string;
      /** `resume`: the task 打开任务 opens. */
      task_id?: TaskKey | null;
      /** `reminder`: the commitment its 延后 and 完成 post to. */
      commitment_id?: string;
      /** `reminder` due card: every commitment it stands for. */
      commitment_ids?: string[];
    });

export type PendingCard = Extract<StackCard, { kind: 'approval' | 'question' | 'review' }>;

/** History row: the original card, so a click can bring it back. */
export interface StackHistoryEntry {
  id: string;
  at: number;
  title: string;
  card: StackCard;
}

/** Card set the stack receives; `now` aligns the stack clock with the data. */
export interface StackPayload {
  now: number;
  cards: StackCard[];
  history: StackHistoryEntry[];
  /** Native asks to show the waiting cards (「去处理」); absent keeps the tab the user chose. */
  tab?: 'now';
}
