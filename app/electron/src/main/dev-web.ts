// The scheme's answers from the vite dev server for a repo launch with `--dev-web-server` (common/dev-web.ts).
import { devCsp, devTarget } from '../common/dev-web.ts';

/** What of the page's request vite reads: it answers a stylesheet `<link>` with CSS and an `import` of it with a module. */
const FORWARDED = ['accept', 'sec-fetch-dest'];

/** Vite's answer to `request`, under the dev CSP; null for a request the shell's own files answer. `log` gets one line per
 *  page document. `fetchUrl` is Electron's `net.fetch`: Chromium's few connections per host take a page load's hundreds of
 *  module requests, which Node's fetch opens all at once and vite drops some of. */
export async function devWebResponse(server: string, request: Request, fetchUrl: (url: string, init: RequestInit) => Promise<Response>,
  log: (line: string) => void): Promise<Response | null> {
  const target = devTarget(server, request.url);
  if (target === null) return null;
  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const page = new URL(target).pathname.endsWith('.html');
  let reply: Response;
  try {
    reply = await fetchUrl(target, { headers });
  } catch (e) {
    log(`DEV_WEB ${target} unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return new Response(`vite dev server unreachable at ${server}`, { status: 502,
      headers: { 'Content-Security-Policy': devCsp(server), 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (page) log(`DEV_WEB ${new URL(request.url).pathname} <- ${target} ${reply.status}`);
  const type = reply.headers.get('content-type');
  return new Response(await reply.arrayBuffer(), { status: reply.status,
    headers: { 'Content-Security-Policy': devCsp(server), ...(type === null ? {} : { 'Content-Type': type }) } });
}
