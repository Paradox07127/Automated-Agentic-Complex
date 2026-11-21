import type { DesktopAnchor, DesktopState } from '../../bridge';

/** What every desktop slot gets; each stays null until native pushes its first value. */
export interface SlotProps {
  anchor: DesktopAnchor | null;
  state: DesktopState | null;
  /** agentd's `/desktop/presence` JSON as it came. */
  presence: unknown;
}

export type CommandSlotProps = SlotProps & { close: () => void };
