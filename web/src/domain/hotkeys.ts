// Hotkey labels outside the settings page: the combos settings.read saved; an unset or unreadable one shows no key.
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../bridge';
import { hotkeyText } from '../bridge/platformText';

export type HotkeyId = 'hk_quick' | 'hk_look' | 'hk_hide' | 'hk_pass';
export type HotkeyLabels = Partial<Record<HotkeyId, string>>;

const IDS: readonly HotkeyId[] = ['hk_quick', 'hk_look', 'hk_hide', 'hk_pass'];
const KEY = ['hotkey-labels'];

export function hotkeyLabels(saved: Readonly<Record<string, unknown>>): HotkeyLabels {
  return Object.fromEntries(IDS.flatMap((id) => (typeof saved[id] === 'string' && saved[id] !== '' ? [[id, hotkeyText(saved[id])]] : [])));
}

/** Read again on every mount and when native changes a saved value. */
export function useHotkeyLabels(): HotkeyLabels {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: async () => hotkeyLabels((await getBridge().settings.read()).saved), retry: false });
  useEffect(() => getBridge().settings.onChange(() => void qc.invalidateQueries({ queryKey: KEY })), [qc]);
  return q.data ?? {};
}
