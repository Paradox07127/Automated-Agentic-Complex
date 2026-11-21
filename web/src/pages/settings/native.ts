// Settings the shell stores in config.json: its schema and saved values.
import type { AgenticComplexBridge, SettingSchema, SettingValue } from '../../bridge';
import type { Opt, Vals } from './fields';

export type Restart = 'none' | 'backend' | 'avatar';

/** settings.schema() row; the shell adds `default` and `restart` to protocol.ts SettingSchema. */
export interface SchemaRow extends SettingSchema {
  default: SettingValue;
  restart: Restart;
}

export interface Native {
  rows: Record<string, SchemaRow>;
  saved: Vals;
  /** Per-id notes from the shell, e.g. a hot key in config.json it could not read. */
  statuses: Record<string, string>;
}

/** Schema and saved values; rejects when config.json cannot be read. */
export async function loadNative(bridge: AgenticComplexBridge, demo: string | null): Promise<Native> {
  const schema = (await bridge.settings.schema()) as SchemaRow[];
  const snap = await bridge.settings.read();
  return { rows: Object.fromEntries(schema.map((r) => [r.id, r])), saved: snap.saved, statuses: snap.statuses };
}

export const optionsOf = (row: SchemaRow | undefined): Opt[] => row?.options ?? [];

/** Schema defaults of the rows in these groups (「恢复默认」). */
export function defaultsOf(native: Native, groups: readonly string[]): Vals {
  return Object.fromEntries(Object.values(native.rows).filter((r) => groups.includes(r.group)).map((r) => [r.id, r.default]));
}
