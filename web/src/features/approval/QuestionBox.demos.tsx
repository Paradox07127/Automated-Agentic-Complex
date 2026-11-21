import { NOW, pick, QUESTIONS } from '../../mock/fixtures';
import { Q1 } from '../../mock/fixtures/ids';
import type { QuestionBoxProps } from './QuestionBox';

export const QuestionBoxDemos: Array<{ name: string; props: QuestionBoxProps }> = [
  { name: 'default', props: { question: pick(QUESTIONS, Q1), now: NOW } },
  { name: 'selected', props: { question: pick(QUESTIONS, Q1), now: NOW, compact: true, selected: '单列一节' } },
  { name: 'text-only', props: { question: pick(QUESTIONS, Q1), now: NOW, text: '包含，但标注来源' } },
  { name: 'deadline', props: { question: { ...pick(QUESTIONS, Q1), seconds_left: 95 }, now: NOW } },
];
