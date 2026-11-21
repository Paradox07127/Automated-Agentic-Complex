// The plug-ins config.json's `plugins` turns on and off (protocol/plugins/plugins.json), and the subsystems this shell
// starts for them.
import { PLUGINS, type PluginId } from './plugins.generated.ts';

export type { PluginId };

/** Each plug-in, on or off. */
export type Plugins = Readonly<Record<PluginId, boolean>>;

/** In the registry's order. */
export const PLUGIN_IDS: readonly PluginId[] = PLUGINS.map((p) => p.id);

/** The registry's `default` of each. */
export const DEFAULT_PLUGINS: Plugins = Object.fromEntries(PLUGINS.map((p) => [p.id, p.default])) as Record<PluginId, boolean>;

export const isPluginId = (id: string): id is PluginId => (PLUGIN_IDS as readonly string[]).includes(id);

/** The ids of those that are on, in the registry's order: `desktop.onState`'s `plugins`. */
export const enabledPlugins = (plugins: Plugins): PluginId[] => PLUGIN_IDS.filter((id) => plugins[id]);

/**
 * What this shell starts. The core's `surfaces` (sitting on and leaning on windows) and `giveWay` always start; the rest
 * are the registry's `shell.subsystems` of the plug-ins that are on:
 * `pushToTalk` 按住说话's key; `attention` each attention sample sent to agentd (the sampler itself runs for give-way);
 * `activity` and `timeline` the recorders; `context` the screen context capturer; `focusTurn` C3 rule 39's turn toward the
 * focused window; `reading` the 屏幕识读 and 框选给她看 entries; `control` the computer control host; `hooks` the session
 * hook script in `<support>/bin`; `sessions` the 会话面板 menu item; `approvals` the 待处理 menu items.
 */
export type Subsystem = 'surfaces' | 'giveWay' | typeof PLUGINS[number]['shell']['subsystems'][number];

const CORE: readonly Subsystem[] = ['surfaces', 'giveWay'];

/** The same on every platform: what the helper cannot do, its hello's ops say. */
export function shellPlan(plugins: Plugins): ReadonlySet<Subsystem> {
  return new Set<Subsystem>([...CORE, ...PLUGINS.filter((p) => plugins[p.id]).flatMap((p): readonly Subsystem[] => p.shell.subsystems)]);
}
