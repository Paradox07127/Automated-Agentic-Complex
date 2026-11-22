// `avatar.motionOverrides.*`, `avatar.playChain` and `avatar.preview.sequence` types (C3 v27 rules 51, 52), re-exported by protocol.ts.
import type { ModSettingsOps } from './modSettings';
import type { MotionChainOps } from './motionChain';
import type { ActionSpeed } from './protocol';

export type * from './modSettings';
export type * from './motionChain';

/** One clip of a pool and its relative weight, an integer 1–100000. */
export interface MotionPoolEntry {
  clip: string;
  weight: number;
}

/**
 * The current character's whole override set as config.json `motion_overrides` keeps it. Keys are 1–128 bytes.
 * `chains`: chain key (its first clip) → on, ≤512. `pools`: event key (may end in `@posture`) or idle tier `idle.t<N>` →
 * the whole pool, ≤64 pools of 1–64 distinct clips. `blend_in`: clip → seconds 0–2, ≤512. `{}` leaves that kind to the pack.
 * `notes`: chain key → the user's note, ≤512 of ≤500 characters; kept in config.json only, never sent to the avatar.
 */
export interface MotionOverrides {
  chains: Record<string, boolean>;
  pools: Record<string, MotionPoolEntry[]>;
  blend_in: Record<string, number>;
  /** Absent when there are none. */
  notes?: Record<string, string>;
}

/** An entry the avatar did not take, and why (C3 v27 rule 51 (d)–(f)). */
export type MotionOverrideAdjusted =
  | { kind: 'chain'; key: string; reason: 'unknown_chain' | 'required' }
  | { kind: 'pool'; key: string; reason: 'unknown_pool' | 'unknown_clip' | 'excluded_family' | 'no_return' | 'stance_mismatch' }
  | { kind: 'blend_in'; key: string; reason: 'unknown_clip' };

/** `avatar.motionOverrides.set`: entries taken per kind, and every entry not taken (one per pool). */
export interface MotionOverridesReply {
  applied: { chains: number; pools: number; blend_in: number };
  adjusted: MotionOverrideAdjusted[];
}

/** `avatar.playChain`: plays the chain that starts at `start` once on the desktop; resolves once she has started it. */
export interface PlayChainRequest {
  start: string;
  speed?: ActionSpeed;
}

/** `avatar.preview.sequence`: 1–32 clips played in order in the live preview, `blend_s` one shorter, each 0–2 s. */
export interface PreviewSequence {
  clips: string[];
  blend_s: number[];
}

/**
 * `avatar.preview.view`, the live preview's inspection camera (C3 预览 XPC `view`): `turn` degrees on her yaw, `tilt` degrees on her
 * pitch (±80), `zoom` the share 0.1–2 of the fitted frame shown, `pan` the shown centre's offset from the fit's in fitted-frame sizes
 * (y down), and `frame` where the fit sits in the placed rect as x, y, w, h shares of it (y down). Zoom and tilt are clamped.
 */
export interface PreviewView {
  turn: number;
  tilt?: number;
  zoom: number;
  pan?: [number, number];
  frame?: [number, number, number, number];
}

/** The motion settings' `avatar` ops; main surface only. */
export interface MotionAvatarOps {
  motionOverrides: {
    /** The current character's stored set; all `{}` when there is none. */
    get(): Promise<MotionOverrides>;
    /** Stores the whole set as the user's and sends it; rejects with `failed` when the avatar did not take it (the store stays). */
    set(o: MotionOverrides): Promise<MotionOverridesReply>;
  };
  playChain(r: PlayChainRequest): Promise<void>;
  /** Structure proposals: check one, or apply it by rebuilding the character pack. */
  motionChain: MotionChainOps;
  /** The current appearance's mod switches (C3 v27 rule 53). */
  modSettings: ModSettingsOps;
  preview: {
    /**
     * Plays the clips once each in the drawn live preview, then her idle; true once its first frame is drawn, false where the
     * shell has no live preview. Rejects with `unavailable` when no live preview is placed, and `invalid_args` outside the limits.
     */
    sequence(s: PreviewSequence): Promise<boolean>;
  };
}
