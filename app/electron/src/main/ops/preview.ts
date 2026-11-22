// `avatar.preview.*`: the character page's live preview. Without a preview host (Windows for now) they are
// `not_implemented`, after the argument checks.
import { BridgeFailure } from '../../common/bridge.ts';
import type { EventSource } from '../../common/page.ts';
import type { Ops, OpsContext } from './context.ts';
import { watch } from './events.ts';

/** A rect of the page's viewport in CSS px. */
export interface PreviewRect { x: number; y: number; w: number; h: number }

export interface PreviewHost {
  /** Viewport rect, optional action id, whether the action loops, and a selection revision that can replay the same action. */
  show(rect: PreviewRect, action: string | null, loop: boolean, revision: number): Promise<boolean>;
  hide(): void;
  /** Preview XPC v2 `sequence`: clips and the blend seconds between them; resolves once its first frame is drawn. */
  sequence(clips: string[], blendSeconds: number[]): Promise<void>;
  /** `avatar.preview.onProgress`: `{fraction}` while a load builds anew, null once none does. */
  readonly progress: EventSource;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bytes = (s: string) => new TextEncoder().encode(s).length;

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
        || !(r.request === undefined || (typeof r.request === 'number' && Number.isSafeInteger(r.request) && r.request >= 0))) {
        throw new BridgeFailure('invalid_args', '{x, y, w, h, action?, loop?, request?}');
      }
      return preview.show({ x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number },
        typeof r.action === 'string' ? r.action : null, r.loop === true, typeof r.request === 'number' ? r.request : 0);
    },
    'avatar.preview.hide': () => {
      host('avatar.preview.hide').hide();
      return null;
    },
    'avatar.preview.sequence': async ([s]) => {
      // Preview XPC v2 `sequence` limits.
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
  };
}
