// Defines `window.agenticComplex` in the page's world before its scripts run; every op goes to the main process. In the main
// window it also draws the character page's live preview (src/main/preview/window.ts).
import { contextBridge, ipcRenderer, sharedTexture, webUtils } from 'electron';
import { MAX_SCOPE_FILES, pastedImages } from '../common/adoption.ts';
import type { Boot, Reply } from '../common/bridge.ts';
import { installBridge, type Push } from '../common/shim.ts';

/** Frames from the main process, fitted inside the rect the page reported; clicks pass through to the page. The canvas fills the
 *  page's `[data-preview-layer]` when it has one (the page's UI stands over it), else it stands over the rect above everything. */
function installPreview(): void {
  let canvas: HTMLCanvasElement | null = null;
  ipcRenderer.on('preview:place', (_e, r: { x: number; y: number; w: number; h: number }) => {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'agentic-complex-preview';
    }
    const layer = document.querySelector('[data-preview-layer]');
    if (canvas.parentElement !== (layer ?? document.documentElement)) (layer ?? document.documentElement).appendChild(canvas);
    canvas.style.cssText = layer
      ? 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;background:transparent'
      : `position:fixed;pointer-events:none;z-index:2147483647;background:transparent;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
    const w = Math.round(r.w * devicePixelRatio), h = Math.round(r.h * devicePixelRatio);
    if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
    canvas.hidden = false;
  });
  // The next place may be another character's (a switch): her last frame must not show until a new one draws.
  ipcRenderer.on('preview:hide', () => {
    if (!canvas) return;
    canvas.hidden = true;
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  });
  // A load that builds anew: the old frame must not stand over the page's loading bar; the next frame draws again.
  ipcRenderer.on('preview:clear', () => {
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  });
  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture: texture }) => {
    try {
      const context = canvas && !canvas.hidden ? canvas.getContext('2d') : null;
      if (!canvas || !context) return;
      const frame = texture.getVideoFrame();
      try {
        const scale = Math.min(canvas.width / frame.displayWidth, canvas.height / frame.displayHeight);
        const w = frame.displayWidth * scale, h = frame.displayHeight * scale;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(frame, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      } finally {
        frame.close();
      }
    } finally {
      texture.release();
    }
  });
}

const boot = ipcRenderer.sendSync('bridge:boot') as Boot | null;
if (boot) {
  contextBridge.executeInMainWorld({
    func: installBridge,
    args: [
      boot,
      (op: string, args: unknown[]) => ipcRenderer.invoke('bridge:invoke', { op, args }) as Promise<Reply>,
      (push: Push) => { ipcRenderer.on('bridge:push', (_e, id, stream, kind, payload) => push(id, stream, kind, payload)); },
      boot.surface === 'main' ? {
        // getPathForFile gives '' for a File the page built itself, so only real drops reach main.
        adopt: (files: File[]) => {
          const batch = Array.prototype.slice.call(files, 0, MAX_SCOPE_FILES) as File[];
          return ipcRenderer.invoke('files:adopt', batch.map(f => webUtils.getPathForFile(f)));
        },
        release: (handle: string) => ipcRenderer.invoke('files:release', handle),
        paste: (items: unknown[]) => ipcRenderer.invoke('files:paste', pastedImages(items)),
      } : undefined,
    ],
  });
  if (boot.surface === 'main') installPreview();
}
