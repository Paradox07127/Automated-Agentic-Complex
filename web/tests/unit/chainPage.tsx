// Mounting 动作 → 编排 over the fake bridge and finding its parts, for the motion-* tests.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { vi } from 'vitest';
import { MOTION_GRAPH } from '../../src/mock/motionGraph';
import type { Toast } from '../../src/pages/character/feedback';
import { MotionSettings } from '../../src/pages/character/motions/MotionSettings';

export const IDLE = 'A_clip_birch_idle_loop';
export const RELAX = 'A_clip_birch_relax_loop';
export const TO_RELAX = 'SourceUI_A_clip_birch_idle_to_relax';
export const THINK = 'A_clip_birch_customized_state_think_start';
export const PONDER = 'A_clip_birch_dialog_state_think_start';
export const PONDER_LOOP = 'A_clip_birch_dialog_state_think_loop';
export const PONDER_END = 'A_clip_birch_dialog_state_think_end';
export const PAT = 'A_clip_birch_customized_single_headpat';
export const WAVE = 'A_clip_birch_dialog_single_wave';
export const FIDGET = 'A_clip_birch_idle_fidget_01';

export const click = (el: Element) => act(async () => void fireEvent.click(el));
export const save = () => click(screen.getByRole('button', { name: '保存' }));

/** The idle.t1 use on FIDGET, which the tests give draw times. */
export const tierUse = () => MOTION_GRAPH.clips.find((c) => c.name === FIDGET)!.uses[0] as Record<string, unknown>;

export async function mount(toast: Toast = vi.fn<Toast>(), offline = false) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MotionSettings offline={offline} toast={toast} />
    </QueryClientProvider>,
  );
  await screen.findByRole('radiogroup', { name: '池子类型' });
}

export function row(key: string) {
  const el = document.querySelector<HTMLElement>(`[data-chain="${key}"]`);
  if (!el) throw new Error(`no row ${key}`);
  return el;
}

export const rows = () => [...document.querySelectorAll<HTMLElement>('[data-chain]')].map((r) => r.dataset.chain);
export const pool = () => document.querySelector<HTMLElement>('[data-pool]')!;
export const detail = () => document.querySelector<HTMLElement>('[data-chain-detail]')!;
export const weight = (key: string) => within(row(key)).getByRole('spinbutton') as HTMLInputElement;
/** The row's ▶ (the dark row's press). */
export const playRow = (key: string) => row(key).querySelector<HTMLButtonElement>('button[aria-pressed]')!;

/** Shows 事件反应 and picks the event pool `key`. */
export async function toEvent(key: string) {
  await click(screen.getByRole('radio', { name: /^事件反应/ }));
  await click(document.querySelector(`[data-pool-cell="${key}"]`)!);
}

/** Opens the chain `key` of session.thinking under 事件反应. */
export async function openChain(key: string) {
  await toEvent('session.thinking');
  await click(within(row(key)).getByRole('button', { name: /^展开/ }));
  return detail();
}

export async function setWeight(key: string, w: string) {
  const input = weight(key);
  await act(async () => {
    fireEvent.change(input, { target: { value: w } });
    fireEvent.blur(input);
  });
}
