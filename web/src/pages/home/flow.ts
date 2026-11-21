import type { Pt } from './Slab';

/** Points along a Catmull-Rom curve through `spine`, `per` to a segment. */
function curve(spine: readonly Pt[], per: number): Pt[] {
  const p = (i: number) => spine[Math.max(0, Math.min(spine.length - 1, i))]!;
  const out: Pt[] = [];
  for (let i = 0; i < spine.length - 1; i++) {
    const [a, b, c, d] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
    for (let s = 0; s < per; s++) {
      const t = s / per;
      const f = (k: 0 | 1) => 0.5 * (2 * b[k] + (c[k] - a[k]) * t + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * t * t + (3 * b[k] - a[k] - 3 * c[k] + d[k]) * t * t * t);
      out.push([f(0), f(1)]);
    }
  }
  out.push(spine[spine.length - 1]!);
  return out;
}

/**
 * Contour lines as deco_btn01/02 draw them: `n` lines beside a smooth curve through `spine`, `gap` apart on average.
 * Each gap swells and narrows along the curve by up to `swell` (below 1, so lines never cross), so the bundle bunches
 * and spreads as contours do on a slope. `seed` shifts the swelling between bundles. Returns one path per line.
 */
export function flow(spine: readonly Pt[], n: number, gap: number, swell: number, seed: number): string[] {
  const pts = curve(spine, 12);
  const normals = pts.map((q, i) => {
    const [a, b] = [pts[Math.max(0, i - 1)]!, pts[Math.min(pts.length - 1, i + 1)]!];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / len, (b[0] - a[0]) / len] as const;
  });
  const off = pts.map(() => 0);
  return Array.from({ length: n }, (_, k) => {
    if (k > 0) pts.forEach((_, i) => (off[i]! += gap * (1 + swell * Math.sin(((i / pts.length) * 2.6 + seed + k * 0.37) * Math.PI))));
    return `M${pts.map((q, i) => `${(q[0] + normals[i]![0] * off[i]!).toFixed(1)} ${(q[1] + normals[i]![1] * off[i]!).toFixed(1)}`).join(' L')}`;
  });
}
