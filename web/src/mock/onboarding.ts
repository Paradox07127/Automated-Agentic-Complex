import type { OnboardingState } from '../bridge/protocol';

// The first-run guide.

export const ONBOARDING_STEPS: Array<Omit<OnboardingState['steps'][number], 'result'>> = [
  { id: 1, number: '01', title: '角色' },
  { id: 2, number: '02', title: '对话' },
  { id: 3, number: '03', title: '声音' },
  { id: 4, number: '04', title: '完成' },
];

export const ONBOARDING_PROFILE = { characterName: '示例乙' };
