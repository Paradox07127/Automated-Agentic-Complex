// The fake bridge's mod settings: values per character and appearance, as native keeps them in config.json `mod_settings`.
import { MOD_SETTINGS } from '../../mock/fixtures';
import type { BridgeError, ModSettingAdjusted, ModSettingsOps, ModSettingValues } from '../protocol';

const reject = (code: string, detail: string) => Promise.reject({ code, detail } satisfies BridgeError);
const byte = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255;

/** Takes the whole set against the mock table: a value the table lacks is drawn as the default, a switch it lacks is dropped. */
export function fakeModSettings(): ModSettingsOps {
  const stored: Record<string, Record<string, ModSettingValues>> = {};
  return {
    get: async ({ character }) => ({ appearances: JSON.parse(JSON.stringify(stored[character] ?? {})) as Record<string, ModSettingValues> }),
    set: async ({ character, appearance, values }) => {
      if (typeof character !== 'string' || typeof appearance !== 'string' || values == null || typeof values !== 'object' || !Object.values(values).every(byte))
        return reject('invalid_args', '{character, appearance, values: {id: 0–255}}');
      const table = MOD_SETTINGS[character]?.[appearance];
      if (!table) return reject('failed', 'invalid');
      const adjusted: ModSettingAdjusted[] = [];
      const drawn: ModSettingValues = {};
      for (const s of table.settings) {
        const v = values[s.id];
        const known = v !== undefined && s.values.some((x) => x.value === v);
        if (v !== undefined && !known) adjusted.push({ id: s.id, reason: 'defaulted' });
        drawn[s.id] = known ? v : s.default;
      }
      for (const id of Object.keys(values)) if (!table.settings.some((s) => s.id === id)) adjusted.push({ id, reason: 'unsupported' });
      stored[character] = { ...stored[character], [appearance]: drawn };
      return { values: { ...drawn }, adjusted };
    },
  };
}
