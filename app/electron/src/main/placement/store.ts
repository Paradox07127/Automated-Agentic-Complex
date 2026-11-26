// The placement files of a support dir: window-positions.json and placements.json (read once, written whole on each record) and the placement keys
// of state.json (read, changed and written back on each save, its other keys kept).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type AvatarPlacement, decodePlacements, decodePositions, type Placements, type Positions, type Rect, type ScreenInfo, withPosition,
} from '../../common/placement.ts';

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** `.atomic`: a temp file renamed over the old one. */
function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, path);
  } catch { /* a failed write is dropped */ }
}

/** `<support>/state.json` as an object; `{}` when it is missing or not one. */
export function readState(supportDir: string): Record<string, unknown> {
  const v = readJson(join(supportDir, 'state.json'));
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/** state.json's per-character saves: `state[key][character] = value`. */
function savePerCharacter(supportDir: string, key: string, character: string, value: unknown): void {
  const state = readState(supportDir);
  const per = state[key];
  state[key] = { ...(typeof per === 'object' && per !== null && !Array.isArray(per) ? per : {}), [character]: value };
  writeJson(join(supportDir, 'state.json'), state);
}

export const saveWindowScale = (supportDir: string, character: string, scale: number) =>
  savePerCharacter(supportDir, 'window_scale', character, scale);
export const saveLastDisplay = (supportDir: string, character: string, display: number) =>
  savePerCharacter(supportDir, 'last_display', character, display);
export const saveLastAppearance = (supportDir: string, character: string, appearance: string) =>
  savePerCharacter(supportDir, 'last_appearance', character, appearance);
export const saveHiddenLayers = (supportDir: string, character: string, hidden: string[]) =>
  savePerCharacter(supportDir, 'hidden_layers', character, hidden);

/** Max(last + 1, now in Unix ms), saved so it never goes back across restarts. */
export function nextTraceEpoch(supportDir: string, nowMs = Date.now()): number {
  const state = readState(supportDir);
  const epoch = Math.max((Number.isInteger(state.trace_epoch) ? state.trace_epoch as number : 0) + 1, Math.floor(nowMs));
  writeJson(join(supportDir, 'state.json'), { ...state, trace_epoch: epoch });
  return epoch;
}

export function saveLastCharacter(supportDir: string, character: string): void {
  writeJson(join(supportDir, 'state.json'), { ...readState(supportDir), last_character: character });
}

/** `<support>/placements.json` as it is now; `{}` when it is missing or does not decode. */
export function readPlacements(supportDir: string): Placements {
  return decodePlacements(readJson(join(supportDir, 'placements.json')));
}

/** The placement files of one support dir. */
export class PlacementFiles {
  readonly supportDir: string;
  private positionsDoc: Positions;
  private placementsDoc: Placements;

  constructor(supportDir: string) {
    this.supportDir = supportDir;
    this.positionsDoc = decodePositions(readJson(join(supportDir, 'window-positions.json')));
    this.placementsDoc = readPlacements(supportDir);
  }

  get positions(): Positions { return this.positionsDoc; }
  get placements(): Placements { return this.placementsDoc; }

  /** A frame on no display is dropped. */
  recordPosition(character: string, frame: Rect, screens: ScreenInfo[]): void {
    const next = withPosition(this.positionsDoc, character, frame, screens);
    if (next === null) return;
    this.positionsDoc = next;
    writeJson(join(this.supportDir, 'window-positions.json'), next);
  }

  recordPlacement(character: string, display: number, entry: { x: number; y: number; scale: number }): void {
    this.placementsDoc = { ...this.placementsDoc, [character]: { ...this.placementsDoc[character], [String(display)]: entry } };
    writeJson(join(this.supportDir, 'placements.json'), this.placementsDoc);
  }

  /** By the reporting avatar's applied viewport; nothing before one is known. */
  recordReported(p: AvatarPlacement, viewport: string | null, character: string): void {
    if (viewport === 'window') {
      saveWindowScale(this.supportDir, character, p.scale);
    } else if (viewport === 'fullscreen') {
      this.recordPlacement(character, p.displayId, { x: p.x, y: p.y, scale: p.scale });
      saveLastDisplay(this.supportDir, character, p.displayId);
    }
  }
}
