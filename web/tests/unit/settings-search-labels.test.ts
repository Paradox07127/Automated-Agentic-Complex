// The search table's titles of 角色 rows against the labels the character page draws (app/electron/src/common/settings.ts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REGISTRY } from '../../src/pages/settings/registry';

/** Web id → schema label, read from settings.ts's item calls and its id tables. */
function schemaLabels(): Map<string, string> {
  const src = readFileSync(resolve(__dirname, '../../../app/electron/src/common/settings.ts'), 'utf8');
  const labelOfKey = new Map<string, string>();
  for (const m of src.matchAll(/\b(?:slider|dropdown|toggle|choice)\('([\w.]+)', '([^']+)'/g)) if (!labelOfKey.has(m[1]!)) labelOfKey.set(m[1]!, m[2]!);
  const out = new Map<string, string>();
  for (const m of src.matchAll(/\['([\w.]+)', (?:'[@\w]+', )?'(\w+)'\]/g)) {
    const label = labelOfKey.get(m[2]!);
    if (label && !out.has(m[1]!)) out.set(m[1]!, label);
  }
  return out;
}

describe('settings search titles', () => {
  // Native groups draw the registry's own title (labelOf); only the character page draws the schema's label.
  it('names every 角色 row as the character page does', () => {
    const labels = schemaLabels();
    const rows = REGISTRY.filter((r) => r.group === '@character' && labels.has(r.id));
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.map((r) => [r.id, r.label])).toEqual(rows.map((r) => [r.id, labels.get(r.id)]));
  });
});
