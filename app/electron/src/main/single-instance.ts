// One shell per support dir: a second one logs LOCKED and exits before it starts anything, and the first one brings its
// main window forward.

export interface SingleInstanceOptions {
  /** `app.requestSingleInstanceLock`, after `userData` is set under the support dir, so that each support dir (a `--config`
   *  test run's too) has its own lock. */
  requestLock(): boolean;
  /** `app.on`: Electron emits `activate` (a relaunch of the running app) on macOS only. */
  on(event: 'second-instance' | 'activate', listener: () => void): void;
  /** Resolves once the shell has started, its main window can be opened. */
  ready: Promise<void>;
  /** Shows and focuses the main window, opening it when there is none. */
  showMain(): void;
  pid: number;
  appPath: string;
  log(line: string): void;
}

/** false once LOCKED is logged: the caller then exits 0. */
export function singleInstance(o: SingleInstanceOptions): boolean {
  if (!o.requestLock()) {
    o.log(`LOCKED pid=${o.pid} app=${o.appPath}: another instance holds the single-instance lock`);
    return false;
  }
  const show = () => { void o.ready.then(() => o.showMain()); };
  o.on('second-instance', show);
  o.on('activate', show);
  return true;
}
