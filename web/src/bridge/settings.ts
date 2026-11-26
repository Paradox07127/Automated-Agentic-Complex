// The bridge's `settings` ops: the editable rows' schema, the saved values, and the checks a save or a destructive change needs.
import type { Unsubscribe } from './protocol';

export type SettingId = string;
export type SettingValue = string | number | boolean | null | string[];

export interface SettingSchema {
  id: SettingId;
  group: string;
  kind: 'toggle' | 'select' | 'text' | 'number' | 'hotkey' | 'path' | 'slider';
  label: string;
  destructive?: boolean;
  options?: Array<{ value: string; label: string }>;
  /** Slider rows: range and step of the stored value; `percent` reads it ×100. */
  min?: number;
  max?: number;
  step?: number;
  format?: 'percent' | 'degrees' | 'days';
}

export interface SettingsSnapshot {
  saved: Record<SettingId, SettingValue>;
  statuses: Record<SettingId, string>;
}

export interface SettingsSaveResult {
  restart: 'none' | 'avatar' | 'backend';
  notApplied: SettingId[];
  error?: string;
}

/** `settings.onChange`: saved values changed, by any page, window or menu. */
export interface SettingsChange {
  ids: SettingId[];
}

export type HotkeyCheck = { ok: true } | { ok: false; conflictWith: string };

/** What turning a destructive setting off would delete now, by agentd category; `total` sums `counts`. */
export interface DeletionPreview {
  total: number;
  counts: Record<string, number>;
}

export interface SettingsOps {
  /** Only ids the UI may edit. */
  schema(): Promise<SettingSchema[]>;
  read(): Promise<SettingsSnapshot>;
  save(changes: Record<SettingId, SettingValue>): Promise<SettingsSaveResult>;
  /**
   * Records that the user confirmed a data-deleting change. The web layer has already shown its own danger confirmation,
   * so the native side only logs the consent and must not ask again; `false`: the shell refused, the change is not written.
   */
  confirmDestructive(id: SettingId): Promise<boolean>;
  /** Counts for the danger dialog of a destructive setting; deletes nothing. */
  previewDestructive(id: SettingId): Promise<DeletionPreview>;
  validateHotkey(id: SettingId, combo: string): Promise<HotkeyCheck>;
  recordHotkey(id: SettingId): Promise<string | null>;
  wipeLocalData(): Promise<void>;
  /** Pushes the ids whose saved value the native side changed outside the settings pages; read them again. */
  onChange(cb: (c: SettingsChange) => void): Unsubscribe;
}
