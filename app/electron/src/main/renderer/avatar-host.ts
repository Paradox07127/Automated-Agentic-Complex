// The host link as index.ts hands it to the ops, and the stored motion settings sent again on her lists.
import { mkdirSync } from 'node:fs';
import { type AvatarHost, resendOverrides } from '../ops/avatar.ts';
import type { OfferedCapability } from './link.ts';

/** What of HostLink the ops reach; `setVisible` goes through the shell's own, click-through all through `setClickThroughAll`. */
export type AvatarLink = Omit<Required<AvatarHost>, 'setVisible' | 'setClickThroughAll' | 'clickThroughAll'> & { clickThroughAll: boolean };

/** The link's hello lists these; the ops send their messages. */
export const MOTION_OFFERS: readonly OfferedCapability[] = ['motion_overrides', 'play_chain', 'action_transport'];
/** The hello lists these too: `avatar.photo.set` sends `set_render.photo`, `avatar.capture` sends `capture`. */
export const CAPTURE_OFFERS: readonly OfferedCapability[] = ['render_live', 'photo', 'capture'];

/** What the shell does around the link's own. */
export interface AvatarShell {
  /** The renderer's `--agentic-complex-capture-dir`; without it there is no capture. */
  captureDir?: string;
  /** notifyCaptureSaved: 已保存截图 with the file name. */
  captureSaved?(file: string): void;
  /** refreshStatusIcon after a toggle. */
  clickThroughChanged?(): void;
}

/** The link as the ops see it, with `avatar.setVisible` through `setHidden`. */
export function linkAvatarHost(link: AvatarLink, setHidden: (hidden: boolean) => boolean, shell: AvatarShell = {}): AvatarHost {
  const captureDir = shell.captureDir;
  return {
    get hello() { return link.hello; }, get companionCapabilities() { return link.companionCapabilities; },
    get hidden() { return link.hidden; }, get currentCharacter() { return link.currentCharacter; },
    get currentAppearance() { return link.currentAppearance; }, get appearances() { return link.appearances; },
    get layers() { return link.layers; }, get hiddenLayers() { return link.hiddenLayers; }, get lastStats() { return link.lastStats; },
    get lastPipeline() { return link.lastPipeline; }, get lastPlacement() { return link.lastPlacement; },
    setVisible: (visible) => setHidden(!visible), stopSpeech: () => link.stopSpeech(), actions: (character) => link.actions(character),
    playAction: (character, id, speed, loop) => link.playAction(character, id, speed, loop), stopAction: () => link.stopAction(),
    controlAction: (op, at) => link.controlAction(op, at), get actionProgress() { return link.actionProgress; },
    setMotionOverrides: (character, overrides) => link.setMotionOverrides(character, overrides),
    playChain: (playId, character, start, speed, onResult) => link.playChain(playId, character, start, speed, onResult),
    send: (m) => link.send(m), on: (listener) => link.on(listener),
    get clickThroughAll() { return link.clickThroughAll; },
    setClickThroughAll: (on) => {
      link.clickThroughAll = on;
      shell.clickThroughChanged?.();
    },
    sendPhoto: (active, aperture, focus) => link.sendPhoto(active, aperture, focus),
    ...(captureDir === undefined ? {} : {
      capture: async (background: string) => {
        mkdirSync(captureDir, { recursive: true });
        const shot = await link.capture(background);
        shell.captureSaved?.(shot.file);
        return shot;
      },
    }),
  };
}

/** The stored motion overrides sent on each of the link's events; the returned function stops it. */
export function resendStoredOverrides(link: Pick<AvatarLink, 'setMotionOverrides' | 'on'>, configPath: string,
  log: (line: string) => void): () => void {
  return link.on((e) => resendOverrides(link, configPath, e, log));
}
