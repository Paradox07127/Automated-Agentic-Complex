// A repo launch's pages from the vite dev server (tools/dev/dev_console.py): the scheme stays agentic-complex-ui://app/, its
// requests go on to vite, and `art/` and `characters/` stay with the shell's own files.
import { CSP, HOST, SCHEME } from './ui.ts';

export const DEV_WEB_FLAG = '--dev-web-server';

/** The dev server `--dev-web-server <url>` names: an http origin on 127.0.0.1 or localhost; null for a packaged app, without
 *  the flag or for any other value. */
export function devWebServer(argv: readonly string[], packaged: boolean): string | null {
  const i = argv.indexOf(DEV_WEB_FLAG);
  if (packaged || i < 0 || i + 1 >= argv.length || !URL.canParse(argv[i + 1]!)) return null;
  const u = new URL(argv[i + 1]!);
  return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port !== '' && u.pathname === '/'
    && u.search === '' && u.hash === '' && u.username === '' && u.password === '' ? u.origin : null;
}

/** The dev server's URL for a page request on the scheme; null for `art/`, `characters/` and anything not on the scheme. */
export function devTarget(server: string, url: string): string | null {
  if (!URL.canParse(url)) return null;
  const u = new URL(url);
  if (u.protocol !== `${SCHEME}:` || u.hostname !== HOST || /^\/(art|characters)(\/|$)/.test(u.pathname)) return null;
  return `${server}${u.pathname}${u.search}`;
}

/** The pages' CSP with what vite's dev pages need: the React refresh preamble and the injected styles are inline, and its
 *  client talks to the server over the HMR websocket and pings it over http when that drops. */
export function devCsp(server: string): string {
  const ws = server.replace(/^http:/, 'ws:');
  return CSP.replace("script-src agentic-complex-ui:", "script-src agentic-complex-ui: 'unsafe-inline'")
    .replace("style-src agentic-complex-ui:", "style-src agentic-complex-ui: 'unsafe-inline'")
    .replace("connect-src 'none'", `connect-src ${ws} ${server}`);
}
