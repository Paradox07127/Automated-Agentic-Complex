// A port of agent/agentd/tests/test_c6_fixtures.py `kind` and `mismatches`; keep the two in step.

export function kind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Python `fnmatch`: `*` and `?` also match `.`, `[...]` is a set and `[!...]` its complement. */
function fnmatch(name: string, pattern: string): boolean {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] ?? '';
    const close = c === '[' ? pattern.indexOf(']', i + 2) : -1;
    if (c === '*') source += '.*';
    else if (c === '?') source += '.';
    else if (close > 0) {
      const set = pattern.slice(i + 1, close);
      source += `[${set.startsWith('!') ? `^${set.slice(1)}` : set}]`;
      i = close;
    } else source += c.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  }
  return new RegExp(`^(?:${source})$`, 's').test(name);
}

/** Differences in key sets (objects layer by layer, arrays by their first item) and JSON types. */
export function mismatches(fixture: unknown, real: unknown, nullable: readonly string[], freeKeys: readonly string[], path = ''): string[] {
  const name = path || '$';
  // "[" escaped: fnmatch reads "[]" as a set, so "turns[].id" would never match.
  if ((fixture === null || real === null) && nullable.some((p) => fnmatch(path, p.replaceAll('[', '[[]')))) return [];
  if (kind(fixture) !== kind(real)) return [`${name}: fixture ${kind(fixture)}, agentd ${kind(real)}`];
  if (Array.isArray(fixture) && Array.isArray(real)) {
    return fixture.length > 0 && real.length > 0 ? mismatches(fixture[0], real[0], nullable, freeKeys, `${path}[]`) : [];
  }
  if (kind(fixture) !== 'object') return [];
  const f = fixture as Record<string, unknown>;
  const r = real as Record<string, unknown>;
  if (freeKeys.includes(path)) {
    const sample = Object.values(f)[0];
    return sample == null ? [] : Object.entries(r).flatMap(([key, value]) => mismatches(sample, value, nullable, freeKeys, `${path}.${key}`));
  }
  const found: string[] = [];
  const onlyFixture = Object.keys(f).filter((k) => !Object.hasOwn(r, k)).sort();
  const onlyReal = Object.keys(r).filter((k) => !Object.hasOwn(f, k)).sort();
  if (onlyFixture.length > 0 || onlyReal.length > 0) {
    found.push(`${name}: keys only in fixture ${JSON.stringify(onlyFixture)}, only in agentd ${JSON.stringify(onlyReal)}`);
  }
  for (const key of Object.keys(f).filter((k) => Object.hasOwn(r, k)).sort()) {
    found.push(...mismatches(f[key], r[key], nullable, freeKeys, path ? `${path}.${key}` : key));
  }
  return found;
}
