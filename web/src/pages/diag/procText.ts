/** CPU as a share of one core: one decimal under 10 %. */
export const cpuText = (p: number | null): string => (p == null ? '—' : `${p < 10 ? p.toFixed(1) : Math.round(p)}%`);
export const memText = (mb: number | null): string => (mb == null ? '—' : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

/** The number and its unit apart, for a readout that draws the unit small. */
export const cpuParts = (p: number | null): [string, string | undefined] => (p == null ? ['—', undefined] : [p < 10 ? p.toFixed(1) : String(Math.round(p)), '%']);
export const memParts = (mb: number | null): [string, string | undefined] => (mb == null ? ['—', undefined] : mb >= 1024 ? [(mb / 1024).toFixed(1), 'GB'] : [String(Math.round(mb)), 'MB']);
