// The scheme the pages load from.
export const SCHEME = 'agentic-complex-ui';
export const HOST = 'app';
export const ORIGIN = `${SCHEME}://${HOST}`;
export const CSP = "default-src 'none'; script-src agentic-complex-ui:; style-src agentic-complex-ui:; img-src agentic-complex-ui: data: blob:; font-src agentic-complex-ui:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export const MIME_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', webp: 'image/webp', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf',
  ico: 'image/x-icon',
};
