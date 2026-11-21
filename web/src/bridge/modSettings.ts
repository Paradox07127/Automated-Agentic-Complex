// `avatar.modSettings.*` types (C3 v27 rule 53), re-exported through motionOverrides.ts.

/** One appearance's switches: switch id → value, an integer 0–255. */
export type ModSettingValues = Record<string, number>;

/** A switch the avatar did not take as sent: `defaulted` draws the table's default, `unsupported` has no such switch in the table. */
export interface ModSettingAdjusted {
  id: string;
  reason: 'defaulted' | 'unsupported';
}

/** `avatar.modSettings.set`: the appearance's whole set; a switch left out takes the table's default. */
export interface ModSettingsRequest {
  character: string;
  appearance: string;
  values: ModSettingValues;
}

/** Every switch's value as drawn, and the ones not taken as sent. */
export interface ModSettingsReply {
  values: ModSettingValues;
  adjusted: ModSettingAdjusted[];
}

/** The character's stored values as config.json `mod_settings` keeps them: appearance → values. */
export interface ModSettingsStored {
  appearances: Record<string, ModSettingValues>;
}

/** Main surface only. */
export interface ModSettingsOps {
  get(r: { character: string }): Promise<ModSettingsStored>;
  /** Stores the set as the user's and sends it; rejects with `failed` when the avatar did not take it. */
  set(r: ModSettingsRequest): Promise<ModSettingsReply>;
}
