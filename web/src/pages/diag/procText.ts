/** CPU as a share of one core: one decimal under 10 %. */
export const cpuText = (p: number | null): string => (p == null ? '—' : `${p < 10 ? p.toFixed(1) : Math.round(p)}%`);
export const memText = (mb: number | null): string => (mb == null ? '—' : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
