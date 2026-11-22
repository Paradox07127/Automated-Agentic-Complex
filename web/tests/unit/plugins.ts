// Plug-in switches for tests that need a plug-in's pages, keys or settings rows.
import { getBridge } from '../../src/bridge';
import { PLUGINS, type PluginId } from '../../src/bridge/plugins.generated';
import { getPlugins, pluginKey, setPlugins } from '../../src/shell/plugins';

/** Turns these plug-ins on (all when none are named); the rest keep their manifest defaults. */
export function pluginsOn(...ids: PluginId[]): void {
  setPlugins(Object.fromEntries(PLUGINS.map((p) => [pluginKey(p.id), ids.length === 0 || ids.includes(p.id) || p.default])));
}

/** Back to the manifest defaults. */
export function pluginsReset(): void {
  setPlugins({});
}

/** Writes the switches set here into the bridge's config.json too, for the settings page, which takes them from there on mount. */
export async function pluginsSaved(): Promise<void> {
  const on = getPlugins();
  await getBridge().settings.save(Object.fromEntries(PLUGINS.map((p) => [pluginKey(p.id), on[p.id]])));
}
