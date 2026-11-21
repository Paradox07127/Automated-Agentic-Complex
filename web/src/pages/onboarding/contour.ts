/** Contour lines of a noise field (marching squares) as an SVG data URL; the guide's large, thin-line backdrop. */
export function contourUrl(w: number, h: number, seed: number): string {
  const N = 64;
  const M = Math.round((N * h) / w);
  const sx = w / N;
  const sy = h / M;
  const f = (x: number, y: number) =>
    Math.sin(x * 0.11 + seed) + Math.sin(y * 0.19 + seed * 1.7) + 0.7 * Math.sin((x * 0.6 + y) * 0.08 + seed * 0.3) + 0.6 * Math.sin(Math.hypot(x - N * 0.35, y - M * 0.55) * 0.21 + seed);
  const g = Array.from({ length: M + 1 }, (_, j) => Array.from({ length: N + 1 }, (_, i) => f(i, j)));
  const at = (j: number, i: number) => g[j]?.[i] ?? 0;
  let d = '';
  for (let lv = -2.4; lv <= 2.6; lv += 0.4) {
    for (let j = 0; j < M; j += 1)
      for (let i = 0; i < N; i += 1) {
        const a = at(j, i);
        const b = at(j, i + 1);
        const c = at(j + 1, i + 1);
        const e = at(j + 1, i);
        const t = (p: number, q: number) => (lv - p) / (q - p);
        const pts: Array<[number, number]> = [];
        if (a < lv !== b < lv) pts.push([(i + t(a, b)) * sx, j * sy]);
        if (b < lv !== c < lv) pts.push([(i + 1) * sx, (j + t(b, c)) * sy]);
        if (e < lv !== c < lv) pts.push([(i + t(e, c)) * sx, (j + 1) * sy]);
        if (a < lv !== e < lv) pts.push([i * sx, (j + t(a, e)) * sy]);
        for (let k = 0; k + 1 < pts.length; k += 2) {
          const [p, q] = [pts[k], pts[k + 1]] as [[number, number], [number, number]];
          d += `M${p[0].toFixed(1)} ${p[1].toFixed(1)}L${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
        }
      }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="none" stroke="#FFFFFF" stroke-width="1"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
