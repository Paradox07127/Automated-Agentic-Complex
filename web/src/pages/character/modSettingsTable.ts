// agentd's GET /characters/:id/mod-settings (C6): each appearance's switch table from the installed character package.
import { get, seg } from '../../bridge/agentd';

export interface ModSettingRow {
  id: string;
  name: string;
  /** Absent counts as `other`. */
  category?: 'clothing' | 'accessory' | 'hair' | 'color' | 'other';
  default: number;
  values: Array<{ value: number; name: string }>;
}

export interface ModSettingsTable {
  character: string;
  package_sha256: string;
  schema: string;
  /** `{}` when the package has no table. */
  appearances: Record<string, { settings: ModSettingRow[] }>;
}

export const readModSettings = (character: string) => get<ModSettingsTable>(`/characters/${seg(character)}/mod-settings`);
