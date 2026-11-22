import type { PickedHandle } from './protocol';

/** A dropped or pasted file's handle; `size` in bytes. */
export type DroppedHandle = PickedHandle & { readonly size: number };

/** The preload's file channels, not ops (app/electron/src/main/ops/adopt.ts): only the shell's main window has them. */
export interface FileAdopt {
  /** Files dropped on the page as `scope_file` handles; files that are not a scope type are left out. */
  adoptDropped?(files: File[]): Promise<DroppedHandle[]>;
  /** Pasted png, jpeg, gif or webp images (≤ 5 MiB each), saved by the shell and held as `scope_file` handles. */
  adoptPasted?(items: Array<{ type: string; data: ArrayBuffer }>): Promise<DroppedHandle[]>;
  /** Gives back an unsent handle; the shell deletes a pasted copy. */
  release?(handle: string): Promise<void>;
}
