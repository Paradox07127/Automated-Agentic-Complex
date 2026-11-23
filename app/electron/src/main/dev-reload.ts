// A dev deployment. tools/release/dev_deploy.py writes each deployment to a new
// directory under `dev_resources`' parent and renames `current` onto it; its dev-receipt.json `part` says what changed
// (Node cannot receive the deployment's notification), so the parent is watched and a new receipt reloads.
import { type FSWatcher, type Stats, readFileSync, watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface DevReloadOptions {
  /** config.json `dev_resources`; null watches nothing. */
  devResources: string | null;
  /** The main window's and the desktop panels' pages load again. */
  reloadWeb(): void;
  /** agentd restarts. */
  restartBackend(): void;
  /** companion.log. */
  log(line: string): void;
}

const PARTS = new Set(['web', 'agentd', 'all']);

const readText = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // None yet, or a deployment half switched.
    return '';
  }
};

const parse = (text: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

/** `commit=<commit>[ dirty]` of the receipt, which needs all four of its fields; `commit=none` without them. */
function commitText(r: Record<string, unknown> | null): string {
  const valid = r !== null && typeof r.commit === 'string' && typeof r.dirty === 'boolean' && typeof r.ui_sha256 === 'string'
    && typeof r.agentd_sha256 === 'string';
  return valid ? `commit=${r.commit as string}${r.dirty ? ' dirty' : ''}` : 'commit=none';
}

export function devReload(o: DevReloadOptions): { stop(): void } {
  if (o.devResources === null) return { stop: () => {} };
  const receiptPath = join(o.devResources, 'dev-receipt.json');
  let seen = readText(receiptPath);
  o.log(`dev_resources ${o.devResources} ${commitText(parse(seen))}`);
  const changed = () => {
    const text = readText(receiptPath);
    if (text === seen) return;
    seen = text;
    const receipt = parse(text), part = receipt?.part;
    if (typeof part !== 'string' || !PARTS.has(part)) return;
    o.log(`dev reload ${part} ${commitText(receipt)}`);
    if (part !== 'agentd') o.reloadWeb();
    if (part !== 'web') o.restartBackend();
  };
  // Directory events keep normal switches fast. Reconcile the receipt inode as well:
  // a coalesced or missed macOS notification must not leave the old deployment running.
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dirname(o.devResources), changed);
    watcher.on('error', (e) => o.log(`dev reload: watch failed: ${e.message}`));
  } catch (e) {
    o.log(`dev reload: cannot watch ${dirname(o.devResources)}: ${e instanceof Error ? e.message : e}`);
  }
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let previous: Stats | undefined;
  const reconcile = async () => {
    const current = await stat(receiptPath).catch(() => undefined);
    if (stopped) return;
    timer = setTimeout(reconcile, 1000).unref();
    if (current && (!previous || current.dev !== previous.dev || current.ino !== previous.ino
        || current.ctimeMs !== previous.ctimeMs || current.size !== previous.size)) changed();
    previous = current;
  };
  void reconcile();
  return { stop: () => { stopped = true; clearTimeout(timer); watcher?.close(); } };
}
