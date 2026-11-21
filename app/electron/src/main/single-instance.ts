// One shell per support dir: a second one logs LOCKED and exits before it starts anything.

export interface SingleInstanceOptions {
  /** `app.requestSingleInstanceLock`, after `userData` is set under the support dir, so that each support dir (a `--config`
   *  test run's too) has its own lock. */
  requestLock(): boolean;
  pid: number;
  appPath: string;
  log(line: string): void;
}

/** false once LOCKED is logged: the caller then exits 0. */
export function singleInstance(o: SingleInstanceOptions): boolean {
  if (o.requestLock()) return true;
  o.log(`LOCKED pid=${o.pid} app=${o.appPath}: another instance holds the single-instance lock`);
  return false;
}
