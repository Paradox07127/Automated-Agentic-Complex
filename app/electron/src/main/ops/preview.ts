// `avatar.preview.*`: the character page's live preview. Without a preview host (Windows for now) they are
// `not_implemented`, after the argument checks.
import { BridgeFailure } from '../../common/bridge.ts';
import type { EventSource } from '../../common/page.ts';
import type { CameraView, StageControl } from '../preview/session.ts';
import type { Ops, OpsContext } from './context.ts';
import { watch } from './events.ts';

/** A rect of the page's viewport in CSS px. */
export interface PreviewRect { x: number; y: number; w: number; h: number }

export interface PreviewHost {
  /** Viewport rect, optional action id, whether the action loops, a selection revision that can replay the same action, and
   *  whether the action plays as the stage (its camera and music, standing at 0 s until resumed). */
  show(rect: PreviewRect, action: string | null, loop: boolean, revision: number, stage?: boolean): Promise<boolean>;
  hide(): void;
  /** Preview `sequence`: clips and the blend seconds between them; resolves once its first frame is drawn. */
  sequence(clips: string[], blendSeconds: number[]): Promise<void>;
  /** `avatar.preview.onProgress`: `{fraction}` while a load builds anew, null once none does. */
  readonly progress: EventSource;
  /** Preview `view`, its zoom and tilt clamped and its defaults filled in. */
  view(v: CameraView): void;
  /** Preview `pause`, `resume` or `seek` of the stage load; nothing without one. */
  control(c: StageControl): void;
  /** `avatar.preview.onPosition`: `{t, duration, playing}` of the stage load on screen, null once there is none. */
  readonly position: EventSource;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bytes = (s: string) => new TextEncoder().encode(s).length;
const numbers = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(finite);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** A frame of the output: x, y, w, h shares with w, h > 0, inside 0–1. */
const inside = ([x, y, w, h]: number[]) => x! >= 0 && y! >= 0 && w! > 0 && h! > 0 && x! + w! <= 1 && y! + h! <= 1;

export function previewOps(ctx: OpsContext): Ops {
  const host = (op: string): PreviewHost => {
    if (!ctx.preview) throw new BridgeFailure('not_implemented', op);
    return ctx.preview;
  };
  return {
    'avatar.preview.show': ([r]) => {
      const preview = host('avatar.preview.show');
      if (!isObject(r) || ![r.x, r.y, r.w, r.h].every(finite) || !((r.w as number) > 0 && (r.h as number) > 0)
        || !(r.action === undefined || r.action === null || (typeof r.action === 'string' && r.action !== ''))
        || !(r.loop === undefined || r.loop === null || typeof r.loop === 'boolean')
        || !(r.request === undefined || (typeof r.request === 'number' && Number.isSafeInteger(r.request) && r.request >= 0))
        || !(r.stage === undefined || r.stage === null || r.stage === false || (r.stage === true && typeof r.action === 'string'))) {
        throw new BridgeFailure('invalid_args', '{x, y, w, h, action?, loop?, request?, stage?: with an action}');
      }
      return preview.show({ x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number },
        typeof r.action === 'string' ? r.action : null, r.loop === true, typeof r.request === 'number' ? r.request : 0, r.stage === true);
    },
    'avatar.preview.hide': () => {
      host('avatar.preview.hide').hide();
      return null;
    },
    'avatar.preview.sequence': async ([s]) => {
      // Preview `sequence` limits.
      const clips = isObject(s) ? s.clips : undefined, blends = isObject(s) ? s.blend_s : undefined;
      if (!Array.isArray(clips) || clips.length < 1 || clips.length > 32
        || !clips.every((c) => typeof c === 'string' && bytes(c) >= 1 && bytes(c) <= 128)
        || !Array.isArray(blends) || blends.length !== clips.length - 1 || !blends.every((b) => finite(b) && b >= 0 && b <= 2)) {
        throw new BridgeFailure('invalid_args', '{clips: 1–32 of 1–128 bytes, blend_s: one fewer of 0–2}');
      }
      await host('avatar.preview.sequence').sequence(clips as string[], blends as number[]);
      return true;
    },
    'avatar.preview.onProgress': (args, page) => watch('avatar.preview.onProgress', host('avatar.preview.onProgress').progress)(args, page),
    'avatar.preview.onPosition': (args, page) => watch('avatar.preview.onPosition', host('avatar.preview.onPosition').position)(args, page),
    'avatar.preview.control': ([c]) => {
      const preview = host('avatar.preview.control');
      if (!isObject(c) || !(c.op === 'pause' || c.op === 'resume' || (c.op === 'seek' && finite(c.at)))) {
        throw new BridgeFailure('invalid_args', "{op: 'pause' | 'resume'} | {op: 'seek', at: finite seconds}");
      }
      preview.control(c.op === 'seek' ? { op: 'seek', at: c.at as number } : { op: c.op });
      return null;
    },
    'avatar.preview.view': ([v]) => {
      const pan = isObject(v) ? (v.pan ?? [0, 0]) : null;
      const frame = isObject(v) ? (v.frame ?? [0, 0, 1, 1]) : null;
      if (!isObject(v) || !finite(v.turn) || !finite(v.zoom) || !(v.tilt === undefined || finite(v.tilt)) || !numbers(pan, 2)
        || !numbers(frame, 4) || !inside(frame)) {
        throw new BridgeFailure('invalid_args', '{turn, tilt?, zoom, pan?: [x, y], frame?: [x, y, w, h] inside 0–1}: finite numbers');
      }
      host('avatar.preview.view').view({ turn: v.turn as number, tilt: clamp((v.tilt as number | undefined) ?? 0, -80, 80),
        zoom: clamp(v.zoom as number, 0.1, 2), pan: [pan[0]!, pan[1]!], frame: [frame[0]!, frame[1]!, frame[2]!, frame[3]!] });
      return null;
    },
  };
}
