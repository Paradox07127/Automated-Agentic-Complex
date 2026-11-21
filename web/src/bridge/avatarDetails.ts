// `avatar.details()`, `avatar.actions()`, `avatar.setActionSwitches()`, outfit layer and playlist reply types, re-exported by protocol.ts.
export type * from './mmd';

/** The avatar host's last C3 `pipeline`. */
export interface AvatarPipelineDetails {
  character: string;
  appearance: string;
  /** The appearance asked for when the host fell back to another; else null. */
  fallbackRequested: string | null;
  ssaa: number;
  shadowResolution: number;
  outline: string;
  displayResolution: boolean;
  /** Render settings the host could not apply, by key. */
  unsupported: string[];
  fpsRequested: number;
  fpsTarget: number;
  /** Why rendering is suspended (`system_sleep`, `screen_sleep`, `session_inactive`, `switching`); null while it runs. */
  suspended: string | null;
  gpuAllocatedMB: number;
  framesSubmitted: number;
  clip: string | null;
  error: string | null;
}

/** `avatar.details()`: what the avatar host reported about itself; null where it reported nothing yet. */
export interface AvatarDetails {
  renderer: string | null;
  /** The host build's git revision. */
  build: string | null;
  pipeline: AvatarPipelineDetails | null;
  /** Window position in screen points and its scale. */
  placement: { x: number; y: number; scale: number } | null;
  /** Both the renderer and this app list C3 `photo` (depth of field from the photo panel), `capture` (the shutter) and `filters`; a shell without the photo panel leaves them out. */
  photo?: boolean;
  capture?: boolean;
  filters?: boolean;
}

/** `avatar.photo.set`: whether the photo panel is open, its f-number (1.4–32) and focus (`auto`, or 0.1–10 m). */
export interface PhotoState {
  active: boolean;
  aperture: number;
  focus: 'auto' | number;
}

export interface AvatarAction {
  id: string;
  label: string;
  /** The saved switch, else `defaultEnabled`. */
  enabled: boolean;
  /** Whether the action is on while the user's table lacks it. */
  defaultEnabled?: boolean;
  /** Group the action belongs to. */
  section?: string;
  /** The character package lacks this action. */
  missing?: boolean;
  /** Why the action must stay on, when it must. */
  requiredReason?: string;
  trigger?: string | null;
  durationS?: number | null;
  isNew?: boolean;
  missingReason?: string | null;
  playable?: boolean;
  /** C3 `motion_media`: the media tracks the renderer plays with it; only on actions that have them. */
  media?: { bgm: boolean; face: boolean; camera: boolean };
}

/** An outfit layer of the appearance the current character wears (`CharacterEntry.layers`). */
export interface CharacterLayer {
  id: string;
  name: string;
  visible: boolean;
}

/** `character.getPlaylist`/`setPlaylist`: the current character's MMD list (config.json `motion_playlists`). */
export interface MotionPlaylist {
  /** Action ids, 1–64 bytes each, at most 128. */
  items: string[];
  loop: 'off' | 'one' | 'all';
  speed: 0.5 | 1 | 2;
}

/** `avatar.playPlaylist`: `reason` is `empty` (no item at `start`) or `not_started` (the avatar took nothing). */
export type PlaylistPlayResult = { ok: true } | { ok: false; reason: string };

/** `avatar.playlistState`: the item playing now; `index` and `id` are null while the list is idle, and `index` is null when a single slot plays an action not in the list. */
export interface PlaylistState {
  playing: boolean;
  index: number | null;
  id: string | null;
}

/** Reply of setActionSwitches: the switches now in effect, the ones the host changed back, and why. */
export interface AvatarSwitchReply {
  switches: Record<string, boolean>;
  adjusted: Array<{ id: string; reason: string }>;
  error?: string;
}

/** An action `character.importMotion` added to the current character. */
export interface ImportedMotion {
  id: string;
  title: string;
  durationS: number;
  hasBgm: boolean;
  format: string;
  warnings: string[];
}

/** `character.importMotion`: the user picks a motion file and an optional BGM in native panels; on success the avatar restarts with the action.
 * `reason`: `cancelled`, or motion_tool's code (`too_many_actions`, `too_many_media`, `bad_vmd`, `too_long`, `missing_bones`, `busy`, `validate_failed`, `internal`, `unsupported_format`, `bad_source`, `no_animation`, `unmapped_skeleton`, `already_imported`); `detail` says what went wrong. */
export type MotionImportResult = { ok: true; action: ImportedMotion } | { ok: false; reason: string; detail?: string };

/** `character.importOutfit`: the user picks an EFMI mod folder in a native panel; on success the avatar restarts with the new appearance.
 * A cancel or a failure rejects with a BridgeError whose code is `cancelled` or outfit_tool's reason (`texture_mismatch`, `unmapped_component`, `validate_failed`, `busy`, …). */
export interface OutfitImportResult {
  ok: true;
  appearance: { id: string; name: string };
  /** The import report's codes for parts of the mod it left out: `texture_unbound:<file>`, `needs_mips:<file>`, …; empty when none. */
  warnings: string[];
}

/** `character.removeOutfit`: the avatar restarts without the imported appearance, its mod settings and its textures.
 * A failure rejects with a BridgeError whose code is outfit_tool's reason (`not_imported`, `busy`, `validate_failed`, `internal`, …). */
export interface OutfitRemoveResult { ok: true; appearance: { id: string } }

/** A motion `character.listImportedMotions` found in the current character's action menu. */
export interface ImportedMotionEntry {
  id: string;
  clip: string;
  title: string;
  format: string;
  durationS: number;
  hasBgm: boolean;
  createdAt: string | null;
  warnings: string[];
}

/** A failed motion library call: motion_tool's code (`unknown_action`, `not_imported`, `bad_title`, `busy`, `validate_failed`, `internal`, …). */
export type MotionEditFailure = { ok: false; reason: string; detail?: string };

/** `character.listImportedMotions`: the current character's imported motions, in action menu order. */
export type ImportedMotionsResult = { ok: true; motions: ImportedMotionEntry[] } | MotionEditFailure;

/** `character.renameMotion`: `title` is the one the package now has; the avatar restarts with it. */
export type MotionRenameResult = { ok: true; id: string; title: string } | MotionEditFailure;

/** `character.removeMotion`: the avatar restarts without the motion. */
export type MotionRemoveResult = { ok: true; id: string } | MotionEditFailure;
