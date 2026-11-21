/** A test instance (config.json loaded, on another support dir than the installed app's)
 *  shows 测试 beside the menu bar icon; `supportDir` is null when config.json did not load. */
export function trayTitle(supportDir: string | null, defaultSupportDir: string): string {
  return supportDir !== null && supportDir !== defaultSupportDir ? '测试' : '';
}
