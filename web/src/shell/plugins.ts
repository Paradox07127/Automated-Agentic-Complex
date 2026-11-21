import { useSyncExternalStore } from 'react';
import type { AgenticComplexBridge, SettingValue } from '../bridge';
import { PLUGINS, type PluginId } from '../bridge/plugins.generated';

export type { PluginId };

/** Every plug-in with its switch; pages read it as is. */
export type PluginState = Readonly<Record<PluginId, boolean>>;

/** The settings id of a plug-in's switch: config.json `plugins.<id>`. */
export const pluginKey = (id: PluginId) => `plugins.${id}`;

export const DEFAULT_PLUGINS: PluginState = Object.fromEntries(PLUGINS.map((p) => [p.id, p.default])) as PluginState;

/** Saved settings to the full switch table: a missing or non-boolean value takes the manifest default. */
export function pluginState(saved: Readonly<Record<string, SettingValue | undefined>>): PluginState {
  return Object.fromEntries(PLUGINS.map((p) => {
    const v = saved[pluginKey(p.id)];
    return [p.id, typeof v === 'boolean' ? v : p.default];
  })) as PluginState;
}

let state: PluginState = DEFAULT_PLUGINS;
const listeners = new Set<() => void>();

/** Takes the switches from saved settings; listeners hear only a real change. */
export function setPlugins(saved: Readonly<Record<string, SettingValue | undefined>>): void {
  const next = pluginState(saved);
  if (PLUGINS.every((p) => next[p.id] === state[p.id])) return;
  state = next;
  listeners.forEach((fn) => fn());
}

/** Reads config.json through the bridge; an unreadable file leaves the switches as they were. */
export async function loadPlugins(bridge: AgenticComplexBridge): Promise<void> {
  try {
    setPlugins((await bridge.settings.read()).saved);
  } catch {
    // The settings page says the file cannot be read.
  }
}

export function getPlugins(): PluginState {
  return state;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function usePlugins(): PluginState {
  return useSyncExternalStore(subscribe, getPlugins);
}

/** agentd's `409 {"error":"plugin_off"}` (an AgentdCallError) for a route whose plug-in it does not run, or an Error wrapping it as its cause. */
export function isPluginOff(e: unknown): boolean {
  return e instanceof Error && ((e as { code?: unknown }).code === 'plugin_off' || isPluginOff(e.cause));
}
