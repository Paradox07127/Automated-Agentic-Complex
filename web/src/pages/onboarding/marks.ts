import type { OnboardingState, OnboardingStep } from '../../bridge';
import type { TabStep } from '../../ui/Tabs';

/** What a passed step still needs: 对话 an account that tested through, 声音 a permission the system refused. */
export interface StepNeeds {
  chat: boolean;
  voice: boolean;
}

/** Each step cell's diamond: dashed when skipped, orange when passed but still needing something, white when done, hollow
 *  when not reached; 完成 is white once the guide is done and has none while it is the step shown. */
export function stepMarks(s: OnboardingState, needs: StepNeeds): Record<OnboardingStep, TabStep | undefined> {
  const mark = (n: OnboardingStep): TabStep | undefined => {
    if (n === 4) return s.done ? 'done' : s.step === 4 ? undefined : 'todo';
    const result = s.steps.find((x) => x.id === n)?.result ?? 'todo';
    if (result === 'skipped') return 'skip';
    if (result === 'todo') return 'todo';
    return (n === 2 && needs.chat) || (n === 3 && needs.voice) ? 'mark' : 'done';
  };
  return { 1: mark(1), 2: mark(2), 3: mark(3), 4: mark(4) };
}
