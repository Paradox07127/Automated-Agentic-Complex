// SIGTERM and SIGINT quit as the tray's 退出 does, on every signal. `app.quit()` is that
// path: `will-quit` stops the renderer, agentd and the helper. Electron's own handler (electron_browser_main_parts_posix.cc)
// quits once and then puts back the default action, so a second signal while the children stop would kill the main process
// and leave them running.

export interface QuitSignalPorts {
  /** process.on. Electron installs its handlers after the main script's first run and they replace Node's, so this is
   *  called once the app is ready. */
  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void;
  /** app.quit. */
  quit(): void;
}

export function quitOnSignals(ports: QuitSignalPorts): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) ports.on(signal, () => ports.quit());
}
