// What each page's WebContents gets: navigation stays on the UI scheme, with http(s) links handed to the system browser
// and no new windows; an edit menu only in text fields; the page's errors in `ui.log`.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import type { ErrorInput } from '../common/error-record.ts';
import { editMenu, type EditItem, externalUrl, navigationAllowed, WEB_LOG, WebErrorLog } from '../common/web-guard.ts';

export interface WebGuardPorts {
  /** The pages' origin (ui.ts `ORIGIN`). */
  origin: string;
  /** Gets http and https URLs only. */
  openExternal(url: string): void;
  popUpMenu(contents: WebContents, items: EditItem[]): void;
  /** Where `ui.log` goes (config.ts `webLogsDir`). */
  logsDir: string;
  /** With pages from the vite dev server: gets its client's `[vite] …` console lines, prefixed with the surface. */
  devLog?: (line: string) => void;
  /** Gets each exception of the page (log.ts recordError). */
  recordError?: (e: ErrorInput) => void;
}

/** A console error that is a page's exception: the page's `page_exception: <message>\n<first component frame>…`
 *  (web/src/shell/pageException.ts), or an uncaught one with its source; null for any other. */
export function pageException(message: string, source: string): ErrorInput | null {
  const [first = '', second = ''] = message.split('\n');
  if (first.startsWith('page_exception: ')) {
    return { component: 'page', code: 'page_exception', message: first.slice('page_exception: '.length), detail: second.trim() };
  }
  if (first.startsWith('Uncaught ')) return { component: 'page', code: 'page_exception', message: first, detail: source };
  return null;
}

/** Appends to `<dir>/ui.log`, first moving it to `ui.log.1` once it has reached `maxFileBytes`. */
function appendUiLog(dir: string, line: string): void {
  const path = join(dir, 'ui.log');
  try {
    mkdirSync(dir, { recursive: true });
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) >= WEB_LOG.maxFileBytes) {
      rmSync(`${path}.1`, { force: true });
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, line);
  } catch { /* a page's error line is not worth failing for, as WebErrorLog.append's `try?` */ }
}

/** `surface` is the page's entry, `main` or `stack`. */
export function guardWebContents(contents: WebContents, surface: string, ports: WebGuardPorts): void {
  contents.on('will-frame-navigate', (e) => {
    if (navigationAllowed(e.url, ports.origin)) return;
    e.preventDefault();
    if (e.isMainFrame && externalUrl(e.url)) ports.openExternal(e.url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (!navigationAllowed(url, ports.origin) && externalUrl(url)) ports.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('context-menu', (_e, params) => {
    const items = editMenu(params);
    if (items.length > 0) ports.popUpMenu(contents, items);
  });
  const log = new WebErrorLog(surface, (line) => appendUiLog(ports.logsDir, line));
  contents.on('console-message', (e) => {
    if (ports.devLog && e.message.startsWith('[vite]')) ports.devLog(`DEV_WEB ${surface} ${e.message}`);
    if (e.level !== 'error') return;
    const exception = ports.recordError ? pageException(e.message, `${e.sourceId}:${e.lineNumber}`) : null;
    if (exception) ports.recordError!(exception);
    const url = contents.getURL(), hash = url.indexOf('#');
    log.record(`${e.message}\n${e.sourceId}:${e.lineNumber}`, hash < 0 ? '' : url.slice(hash + 1), Date.now());
  });
}
