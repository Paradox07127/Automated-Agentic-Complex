// Desktop stack card types the shell adds beside the domain cards; protocol.ts re-exports them.
import type { StackCard as DomainStackCard, StackHistoryEntry as DomainStackHistoryEntry, StackPayload as DomainStackPayload } from '../domain';

interface DesktopCardBase {
  id: string;
  /** Epoch ms on the stack clock. */
  at: number;
  collapsed?: boolean;
  receipt?: string;
  kind: 'notice';
  title: string;
  /** The domain notices' other fields, which these never carry. */
  body?: never;
  backoff?: never;
  task_id?: never;
}

/** One thing dropped on her (C3 `drop`): a file's absolute path, name and the handle a scope reads it by, a link, or a text; never a file's contents. */
export type DropItem = { kind: 'file'; path: string; name: string; handle: string } | { kind: 'url'; url: string } | { kind: 'text'; text: string };

/** The notice cards native raises itself (StackSource `setComputerUse`, `setVoiceHint`, `setAvatarLoading`, `addDrop`); 屏幕识读 is the domain `look` notice. */
export type DesktopStackCard =
  | (DesktopCardBase & {
      variant: 'computer';
      phase: 'observing' | 'executing' | 'verifying' | 'paused';
      target_app: string | null;
      target_title: string | null;
      action: string;
      scopes: string[];
    })
  | (DesktopCardBase & {
      variant: 'voice';
      phase: 'listening' | 'sent' | 'discarded' | 'downloading' | 'mic_denied';
      /** Transcript, sent text, why it was not sent, or the 麦克风 notice. */
      text?: string;
      elapsed_s?: number;
      fraction?: number;
      received_mb?: number;
      total_mb?: number;
    })
  | (DesktopCardBase & {
      variant: 'loading';
      phase: 'loading' | 'recovering' | 'failed';
      character?: string;
      /** `recovering`: when the supervisor tries again (epoch ms). */
      retry_at?: number;
    })
  | (DesktopCardBase & {
      variant: 'drop';
      items: DropItem[];
      /** Her side left items out or clipped a text. */
      truncated: boolean;
    });

/** A history row whose card may be a native one. */
export type StackHistoryEntry = Omit<DomainStackHistoryEntry, 'card'> & { card: DomainStackCard | DesktopStackCard };

/** Card set the stack receives: the domain cards and the native ones. */
export type StackPayload = Omit<DomainStackPayload, 'cards' | 'history'> & { cards: (DomainStackCard | DesktopStackCard)[]; history: StackHistoryEntry[] };

/** `confirmed`: the second click of a dangerous approval's in-card 确认批准. */
export interface DecideOptions {
  confirmed?: boolean;
}
