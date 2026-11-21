// The page-world half of `window.agenticComplex`.
import type { Boot, Reply } from './bridge.ts';

/** Delivers a stream event or reload to the subscription `id` the shim gave it. */
export type Push = (id: number, stream: string, kind: 'event' | 'reload', payload: { event: string; id: string | null; data: string }) => void;

interface Subscription { stream: string; onEvent: (e: { event: string; id: string | null; data: string }) => void; onReload: () => void }

/**
 * Defines `window.agenticComplex` (web/src/bridge/protocol.ts). The preload runs this in the page's world from its
 * source text, so it must use nothing outside its own body. Every op goes to `invoke`; a refusal rejects with an
 * Error carrying `code` and `detail`. A subscription returns its unsubscribe at once and is dropped when refused;
 * the void `window.*` calls send without waiting. `listen` receives the function that delivers pushes.
 */
export function installBridge(boot: Boot, invoke: (op: string, args: unknown[]) => Promise<Reply>, listen: (push: Push) => void): void {
  const watch = new Set(boot.kinds.watch), sync = new Set(boot.kinds.sync), streamOps = new Set(boot.kinds.stream);
  function failure(code: string, detail?: string): Error {
    const e = new Error(detail ? code + ': ' + detail : code) as Error & { code: string; detail?: string };
    e.code = code;
    if (detail) e.detail = detail;
    return e;
  }
  function call(op: string, args: ArrayLike<unknown>): Promise<unknown> {
    const list = Array.prototype.map.call(args, (a: unknown) => (a === undefined ? null : a)) as unknown[];
    return invoke(op, list).then((reply) => {
      if (reply.ok) return reply.value;
      throw failure(reply.error.code, reply.error.detail);
    });
  }
  const streams = new Map<number, Subscription>();
  let lastStream = 0;
  function stream(op: string) {
    const name = op.slice(0, op.indexOf('.'));
    const unsubscribe = op.replace(/subscribe$/, 'unsubscribe');
    return (onEvent: Subscription['onEvent'], onReload: () => void, afterSeq?: string) => {
      const id = ++lastStream;
      streams.set(id, { stream: name, onEvent, onReload });
      call(op, [id, afterSeq]).catch(() => { streams.delete(id); });
      return () => {
        if (!streams.delete(id)) return;
        call(unsubscribe, [id]).catch(() => {});
      };
    };
  }
  // `on<Name>(cb)`: each event's data is the JSON object for `cb`. `stack.onCards` hands `{error}` to its `onError`.
  function watcher(op: string) {
    return (cb: (value: unknown) => void, onError?: (e: unknown) => void) => {
      const id = ++lastStream;
      const onEvent = (e: { data: string }) => {
        const value = JSON.parse(e.data);
        if (op === 'stack.onCards' && value && value.error) { if (onError) onError(value.error); }
        else cb(value);
      };
      streams.set(id, { stream: op, onEvent, onReload: () => {} });
      call(op, [id]).catch(() => { streams.delete(id); });
      return () => {
        if (!streams.delete(id)) return;
        call('events.unsubscribe', [id]).catch(() => {});
      };
    };
  }
  // Unsubscribing is local; the main process drops its ids with the document.
  function routes(onRoute: (route: string) => void) {
    const id = ++lastStream;
    streams.set(id, { stream: 'route', onEvent: (e) => onRoute(e.data), onReload: () => {} });
    call('window.onRoute', [id]).catch(() => { streams.delete(id); });
    return () => { streams.delete(id); };
  }
  listen((id, name, kind, payload) => {
    const s = streams.get(id);
    if (!s || s.stream !== name) return;
    if (kind === 'event') s.onEvent({ event: payload.event, id: payload.id, data: payload.data });
    else if (kind === 'reload') s.onReload();
  });
  function method(op: string): unknown {
    if (streamOps.has(op)) return stream(op);
    if (op === 'window.onRoute') return routes;
    if (watch.has(op)) return watcher(op);
    if (sync.has(op)) return function (...args: unknown[]) { call(op, args).catch(() => {}); };
    return function (...args: unknown[]) { return call(op, args); };
  }
  type Node = { [k: string]: unknown };
  const bridge: Node = { surface: boot.surface, platform: boot.platform, capabilities: boot.capabilities };
  for (const op of boot.ops) {
    const parts = op.split('.');
    let node = bridge;
    for (let i = 0; i < parts.length - 1; i++) node = (node[parts[i]] as Node | undefined) ?? (node[parts[i]] = {}) as Node;
    node[parts[parts.length - 1]] = method(op);
  }
  (function freeze(o: Node) {
    for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') freeze(o[k] as Node);
    Object.freeze(o);
  })(bridge);
  Object.defineProperty(window, 'agenticComplex', { value: bridge, enumerable: true });
}
