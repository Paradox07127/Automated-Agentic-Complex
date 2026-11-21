// 链详情「预览这条链」: the chain's clips in the shell's live preview over the character stage (preview XPC v2 `sequence`).
import { getBridge } from '../../../bridge';

/** Shows the live preview over the character stage first when it is not drawing there, as the stage does; then plays the clips. */
export async function previewChain(clips: string[], blend_s: number[]): Promise<boolean> {
  const preview = getBridge().avatar.preview;
  const stage = document.querySelector<HTMLElement>('[data-preview-stage]');
  if (stage && !stage.hasAttribute('data-live')) {
    const r = stage.getBoundingClientRect();
    if (!(await preview.show({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }))) return false;
  }
  return preview.sequence({ clips, blend_s });
}
