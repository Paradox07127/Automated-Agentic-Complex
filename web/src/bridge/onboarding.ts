// `onboarding` ops of the bridge, re-exported by protocol.ts.

/** 1 选角色, 2 怎么陪你, 3 完成. */
export type OnboardingStep = 1 | 2 | 3;
/** 只陪伴 runs without light AI, 陪伴加对话 with it. */
export type OnboardingCompanion = 'pet' | 'chat';

export interface OnboardingState {
  steps: Array<{ id: OnboardingStep; number: string; title: string }>;
  step: OnboardingStep;
  done: boolean;
  /** Steps 1 and 2 go on; step 3 only completes. */
  canAdvance: boolean;
  characterName: string;
  completionError: string | null;
}

export interface OnboardingChoice {
  companion: OnboardingCompanion;
  /** 设置 › 插件 instead of the choice's own end: home for pet, 设置 › AI 账号 for chat. */
  destination?: 'plugins';
}

export interface OnboardingOps {
  state(): Promise<OnboardingState>;
  advance(): Promise<OnboardingState>;
  back(): Promise<OnboardingState>;
  /** Only step 3: stores the choice as `plugins.light_ai` and marks onboarding_done; a failed save leaves done false. */
  complete(choice: OnboardingChoice): Promise<OnboardingState>;
}
