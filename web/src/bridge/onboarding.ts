// `onboarding` ops of the bridge, re-exported by protocol.ts.
import type { Unsubscribe } from './protocol';

export type OnboardingPermissionKind = 'screenRecording' | 'accessibility' | 'microphone' | 'automation' | 'loginItem';
export type OnboardingPermissionState = 'granted' | 'denied' | 'undetermined' | 'askWhenUsed';
export type OnboardingStep = 1 | 2 | 3;

export interface VoiceTrial {
  levels: number[];
  elapsed: string;
  transcript: string;
}

export interface OnboardingState {
  steps: Array<{ id: OnboardingStep; number: string; title: string }>;
  step: OnboardingStep;
  done: boolean;
  canAdvance: boolean;
  canSkip: boolean;
  permissions: Array<{
    kind: OnboardingPermissionKind;
    title: string;
    purpose: string;
    state: OnboardingPermissionState;
    needsSystemSettings: boolean;
  }>;
  characterName: string;
  callName: string;
  birthday: string;
  talkKey: string;
  trial: VoiceTrial;
  hooks: Array<{ id: string; name: string; connected: boolean; lastEvent: string | null; installHint: string; installSteps: string[] }>;
  hooksCheckedAt: string;
  saveError: string | null;
  completionError: string | null;
}

export interface OnboardingProfile {
  callName?: string;
  birthday?: string;
}

export interface OnboardingOps {
  /** Refreshes permissions, connected tools and the saved profile. */
  state(): Promise<OnboardingState>;
  /** Step 2 saves the facts explicitly entered by the user before advancing. */
  advance(profile?: OnboardingProfile): Promise<OnboardingState>;
  back(): Promise<OnboardingState>;
  /** Step 1 closes for later; step 3 finishes, like complete(). */
  skip(): Promise<OnboardingState>;
  /** Only step 3 can mark onboarding_done; failed saves leave done false. */
  complete(destination?: 'home' | 'chat' | 'privacy' | 'model'): Promise<OnboardingState>;
  requestPermission(kind: OnboardingPermissionKind): Promise<OnboardingState>;
  openSettings(kind: OnboardingPermissionKind): Promise<OnboardingState>;
  /** Try the configured talkKey; the native hotkey supplies levels, elapsed time and transcript. */
  onVoiceTrial(cb: (trial: VoiceTrial) => void): Unsubscribe;
}
