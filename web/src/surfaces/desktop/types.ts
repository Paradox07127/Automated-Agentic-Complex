import type { DesktopAnchor, DesktopCommand, DesktopState } from '../../bridge';

/** What every desktop slot gets; each stays null until native pushes its first value. */
export interface SlotProps {
  anchor: DesktopAnchor | null;
  state: DesktopState | null;
  /** agentd's `/desktop/presence` JSON as it came. */
  presence: unknown;
}

/** `command`: the last one native sent; the opening one arrives before the slot mounts. */
export type CommandSlotProps = SlotProps & { command: DesktopCommand | null; close: () => void };
