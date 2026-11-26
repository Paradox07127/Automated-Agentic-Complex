// The bridge's `character` ops: the roster, switching, and the packages, motions, outfits and MMD list a character holds.
import type { CharacterLayer, ImportedMotionsResult, MotionImportResult, MotionPlaylist, MotionRemoveResult, MotionRenameResult,
  OutfitImportResult, OutfitRemoveResult } from './avatarDetails';
import type { ImportStateOps } from './mmd';

export interface CharacterAppearance {
  id: string;
  name: string;
  desc: string;
  kind?: 'original' | 'imported';
  /** Imported only: its import report's warning codes. */
  warnings?: string[];
}

export interface CharacterEntry {
  id: string;
  name: string;
  /** Latin name for the nameplate. */
  en: string;
  appearances: CharacterAppearance[];
  active: boolean;
  /** The package has a voice profile; without one she only shows text and never speaks (agentd `voice_enabled`). */
  voice: boolean;
  /** `agentic-complex-ui://app/characters/<id>/head.png`; absent when the package has no head. */
  head?: string;
  /** `agentic-complex-ui://app/characters/<id>/portrait.png` (≤1024 px); absent when the package has no portrait. */
  portrait?: string;
  /** `agentic-complex-ui://app/characters/<id>/background.png`, the character page's watermark; absent when the package has none. */
  background?: string;
  /** The current character only, and only when her appearance has outfit layers. */
  layers?: CharacterLayer[];
}

/** Switch result; a rejection names the CharacterSwitch stage it stopped at and why. */
export type CharacterSwitchResult = { ok: true } | { ok: false; stage: 'prepare' | 'avatar' | 'commit'; reason: string };

export type CharacterOps = ImportStateOps & {
  list(): Promise<CharacterEntry[]>;
  switchTo(id: string): Promise<CharacterSwitchResult>;
  importPackage(): Promise<{ ok: boolean; reason?: string }>;
  importMotion(): Promise<MotionImportResult>;
  importOutfit(): Promise<OutfitImportResult>;
  removeOutfit(character: string, appearanceId: string): Promise<OutfitRemoveResult>;
  /** `character` is the one the page shows; another current character answers `{ok: false, reason: 'character_changed'}`, as renameMotion and removeMotion do. */
  listImportedMotions(character: string): Promise<ImportedMotionsResult>;
  /** `id` is 1–64 bytes; `title` is trimmed and must then be 1–64 characters, else the call rejects with `bad_args`. */
  renameMotion(character: string, id: string, title: string): Promise<MotionRenameResult>;
  removeMotion(character: string, id: string): Promise<MotionRemoveResult>;
  /** `character_changed` when another character is current. */
  getPlaylist(character: string): Promise<MotionPlaylist>;
  setPlaylist(character: string, p: MotionPlaylist): Promise<{ ok: true }>;
};
