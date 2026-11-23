// Velopack's Setup.exe and Update.exe start the installed exe with --veloapp-install, -updated, -obsolete or -uninstall and
// a version; run() answers those by exiting the process, and otherwise returns.

/** The part of the velopack package the shell uses. */
export interface VelopackSdk {
  VelopackApp: { build(): { run(): void } };
}

/** Velopack's startup handling, Windows only: the package's win-x64 native module ships beside dist/ in node_modules\velopack
 *  (build.mjs keeps it out of the bundle), the macOS app carries none. */
export async function velopackStartup(load: () => Promise<VelopackSdk> = () => import('velopack')): Promise<void> {
  (await load()).VelopackApp.build().run();
}
