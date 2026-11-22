// `onboarding` ops of the bridge, re-exported by protocol.ts.

/** 1 角色, 2 对话, 3 声音, 4 完成. */
export type OnboardingStep = 1 | 2 | 3 | 4;
/** A step passed with 下一步 is done, with 稍后再连 / 先不导入 skipped; one not passed that way is todo. */
export type OnboardingResult = 'done' | 'skipped' | 'todo';
/** home: the main window at 主页 (打开主窗口); talk: the desktop's 快速输入 beside her (和她聊几句). */
export type OnboardingDestination = 'home' | 'talk';

export interface OnboardingState {
  steps: Array<{ id: OnboardingStep; number: string; title: string; result: OnboardingResult }>;
  step: OnboardingStep;
  done: boolean;
  /** Steps 1–3 go on; 完成 only completes. */
  canAdvance: boolean;
  characterName: string;
  completionError: string | null;
}

export interface OnboardingOps {
  state(): Promise<OnboardingState>;
  /** `skip`: the step left counts as skipped. */
  advance(opts?: { skip: true }): Promise<OnboardingState>;
  back(): Promise<OnboardingState>;
  /** A step cell: any step, forward too. */
  goto(step: OnboardingStep): Promise<OnboardingState>;
  /** 跳过引导: marks onboarding_done from any step and closes the guide; the values saved on the way stay. */
  skip(): Promise<OnboardingState>;
  /** Only on 完成: marks onboarding_done and closes the guide, then opens `destination`; a failed save leaves done false. */
  complete(end?: { destination?: OnboardingDestination }): Promise<OnboardingState>;
}
