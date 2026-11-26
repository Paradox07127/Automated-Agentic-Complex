// The five ambient colours (mean, top, bottom, left, right) from the platform helper's `capture.ambient` image, and the `render_ambient` setting
// the ambient sampler reads.

/** Linear sRGB, each component 0–1. */
export type Rgb = [number, number, number];
export type AmbientColors = Record<'mean' | 'top' | 'bottom' | 'left' | 'right', Rgb>;

/** The image side, the tick, the wallpaper's own interval, and the change that counts as new colours. */
export const AMBIENT = { side: 16, intervalMs: 1000, wallpaperMs: 30_000, threshold: 0.02 } as const;

const f = Math.fround;

/** The sRGB transfer undone, in 32-bit float. */
export function ambientLinear(c: number): number {
  return f(c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
}

const LUT = Array.from({ length: 256 }, (_, i) => ambientLinear(f(i / 255)));

/** `rgba` rows run top to bottom; alpha is ignored. Each side is the average of that third of the image. */
export function reduceAmbient(rgba: Uint8Array, width: number, height: number): AmbientColors {
  const average = (x0: number, x1: number, y0: number, y1: number): Rgb => {
    const sum: Rgb = [0, 0, 0];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        for (let k = 0; k < 3; k++) sum[k] = f(sum[k]! + LUT[rgba[i + k]!]!);
      }
    }
    const n = f((x1 - x0) * (y1 - y0));
    return sum.map((s) => f(s / n)) as Rgb;
  };
  const tw = Math.max(1, Math.floor(width / 3)), th = Math.max(1, Math.floor(height / 3));
  return { mean: average(0, width, 0, height), top: average(0, width, 0, th), bottom: average(0, width, height - th, height),
    left: average(0, tw, 0, height), right: average(width - tw, width, 0, height) };
}

/** The `colors` of an `ambient_sample`: each component to 3 decimals. */
export function ambientWire(c: AmbientColors): AmbientColors {
  const rgb = (v: Rgb): Rgb => v.map((x) => Math.round(x * 1000) / 1000) as Rgb;
  return { mean: rgb(c.mean), top: rgb(c.top), bottom: rgb(c.bottom), left: rgb(c.left), right: rgb(c.right) };
}

/** True when there is no previous sample or any component of any colour moved by more than `threshold`. */
export function ambientChanged(a: AmbientColors | null, b: AmbientColors, threshold: number = AMBIENT.threshold): boolean {
  if (a === null) return true;
  return (['mean', 'top', 'bottom', 'left', 'right'] as const).some((k) => a[k].some((v, i) => Math.abs(f(v - b[k][i]!)) > f(threshold)));
}

/** config.json `render_ambient`: `screen`, else the wallpaper unless `off`; anything but a string is `off`. */
export function ambientMode(settings: Record<string, unknown>): string {
  return typeof settings.render_ambient === 'string' ? settings.render_ambient : 'off';
}
