// C6 over HTTP: `/health` by port, token routes with ui-runtime.json's ui_token, and `GET /feed`
// followed across disconnects.
import { readFileSync, statSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { Backoff, type Health, parseHealth } from '../../common/agentd.ts';
import { type AgentdState, decodeRuntime, decodeState, feedStreamEdge, type Runtime, type SSEEvent, SSEParser } from '../../common/c6.ts';

/** One `GET /health` probe: 1 s without a byte or 2 s in all is unreachable. */
export function health(port: number): Promise<Health> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (h: Health) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(h);
    };
    const timer = setTimeout(() => finish({ kind: 'unreachable' }), 2000);
    const req = httpRequest({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          finish(parseHealth(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        } catch {
          finish({ kind: 'unreachable' });
        }
      });
      res.on('error', () => finish({ kind: 'unreachable' }));
    });
    req.on('timeout', () => finish({ kind: 'unreachable' }));
    req.on('error', () => finish({ kind: 'unreachable' }));
    req.end();
  });
}

/** Seconds without a byte before a request fails (C6 names no timeout of its own). */
export const REQUEST_IDLE_TIMEOUT = 60;

export interface Reply {
  status: number;
  body: Buffer;
}

/** `/feed` answered with `status` instead of 200. */
export class FeedStatusError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

function send(url: URL, method: string, headers: Record<string, string>, idleTimeout: number, body?: Buffer): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers, timeout: idleTimeout * 1000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`agentd ${method} ${url.pathname}: timed out after ${idleTimeout} s without a byte`)));
    req.on('error', reject);
    req.end(body);
  });
}

/** ui-runtime.json's `base_url` as the origin every request goes to: http on 127.0.0.1 or [::1] with a port, and nothing
 *  else, so the token never leaves this machine's agentd. */
function loopbackOrigin(baseUrl: string): string {
  let url: URL | null = null;
  try {
    url = new URL(baseUrl);
  } catch { /* refused below */ }
  if (url === null || url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') || url.port === ''
    || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('ui-runtime.json: base_url is not http on 127.0.0.1 or [::1] with a port');
  }
  return url.origin;
}

export class AgentdClient {
  readonly runtimePath: string;
  private readonly idleTimeout: number;
  private cached: { stamp: string; runtime: Runtime } | undefined;

  /** `runtimePath`: `<agentd_state_dir>/ui-runtime.json`; `idleTimeout` in seconds, tests shorten it. */
  constructor(runtimePath: string, idleTimeout = REQUEST_IDLE_TIMEOUT) {
    this.runtimePath = runtimePath;
    this.idleTimeout = idleTimeout;
  }

  /** agentd writes a fresh ui_token on every start; the file is read again whenever its inode, mtime or size changes.
   *  `baseUrl` is the checked origin. */
  runtime(fresh = false): Runtime {
    let stamp: string | undefined;
    try {
      const st = statSync(this.runtimePath, { bigint: true });
      stamp = `${st.ino}:${st.mtimeNs}:${st.size}`;
    } catch { /* read below, which throws */ }
    if (!fresh && stamp !== undefined && this.cached?.stamp === stamp) return this.cached.runtime;
    const decoded = decodeRuntime(JSON.parse(readFileSync(this.runtimePath, 'utf8')));
    const runtime = { baseUrl: loopbackOrigin(decoded.baseUrl), uiToken: decoded.uiToken };
    this.cached = stamp === undefined ? undefined : { stamp, runtime };
    return runtime;
  }

  private target(path: string, fresh: boolean): { url: URL; auth: string } {
    const runtime = this.runtime(fresh);
    return { url: new URL(runtime.baseUrl + path), auth: `Bearer ${runtime.uiToken}` };
  }

  /** `path` includes the query; `json` undefined sends no body; `extra` headers go with both sends. A non-2xx reply is
   *  returned; throws only when the runtime file cannot be read, agentd cannot be reached or sends nothing for
   *  `idleTimeout`. A 401 reads the runtime file again and sends once more. */
  async request(method: string, path: string, json?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
    const body = json === undefined ? undefined : Buffer.from(JSON.stringify(json));
    const headers = (auth: string): Record<string, string> =>
      ({ ...extra, Authorization: auth, ...(body !== undefined && { 'Content-Type': 'application/json' }) });
    const first = this.target(path, false);
    const reply = await send(first.url, method, headers(first.auth), this.idleTimeout, body);
    if (reply.status !== 401) return reply;
    const retry = this.target(path, true);
    return send(retry.url, method, headers(retry.auth), this.idleTimeout, body);
  }

  async state(): Promise<AgentdState> {
    const reply = await this.request('GET', '/state');
    if (reply.status !== 200) throw new Error(`/state: HTTP ${reply.status}`);
    return decodeState(JSON.parse(reply.body.toString('utf8')));
  }

  /** One event-stream connection, sending `lastEventId` as `Last-Event-ID`; rejects with `FeedStatusError` on another
   *  status than 200, and resolves when the connection ends. */
  stream(path: string, lastEventId: string | undefined, signal: AbortSignal, onEvent: (e: SSEEvent) => void,
    onOpen: () => void = () => {}): Promise<void> {
    const { url, auth } = this.target(path, true);
    const headers: Record<string, string> = { Authorization: auth, Accept: 'text/event-stream' };
    if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;
    return new Promise((resolve, reject) => {
      // agentd sends a heartbeat every 10 s, so `idleTimeout` without a byte means it hangs.
      const req = httpRequest(url, { method: 'GET', headers, signal, timeout: this.idleTimeout * 1000 }, (res: IncomingMessage) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new FeedStatusError(res.statusCode ?? 0));
          return;
        }
        onOpen();
        const parser = new SSEParser();
        let pending: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          let start = 0;
          for (let i = chunk.indexOf(0x0a); i >= 0; i = chunk.indexOf(0x0a, start)) {
            pending.push(chunk.subarray(start, i));
            let line = Buffer.concat(pending);
            pending = [];
            if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
            start = i + 1;
            const event = parser.feed(line.toString('utf8'));
            try {
              if (event) onEvent(event);
            } catch (e) {
              // Inside the socket's listener a throw would be uncaught: it ends this stream instead.
              reject(e);
              req.destroy();
              return;
            }
          }
          if (start < chunk.length) pending.push(chunk.subarray(start));
        });
        res.on('end', () => resolve());
        res.on('error', reject);
        res.on('close', () => resolve());
      });
      req.on('timeout', () => req.destroy(new Error(`agentd GET ${url.pathname}: no byte for ${this.idleTimeout} s`)));
      req.on('error', reject);
      req.end();
    });
  }
}

/** Resolves after `ms`, or at once when `signal` aborts; leaves no listener on `signal` either way. */
export const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  }
  signal.addEventListener('abort', done);
});

/** Follows an agentd event stream (`GET /feed` by default) and reconnects after each end or failure, waiting
 *  `Backoff.delay` seconds of the consecutive failures (a connection that opened counts from zero again). */
export class FeedClient {
  private readonly client: AgentdClient;
  private readonly path: string;
  private abort: AbortController | undefined;

  constructor(runtimePath: string, path = '/feed') {
    this.client = new AgentdClient(runtimePath);
    this.path = path;
  }

  /** Each (re)connect sends `lastEventID()` as `Last-Event-ID`, or the last id this client saw when it gives undefined. */
  start(onEvent: (e: SSEEvent) => void, lastEventID: () => string | undefined | Promise<string | undefined> = () => undefined): void {
    this.stop();
    const abort = new AbortController();
    this.abort = abort;
    void (async () => {
      let lastId: string | undefined;
      let failures = 0;
      while (!abort.signal.aborted) {
        try {
          const resume = (await lastEventID()) ?? lastId;
          await this.client.stream(this.path, resume, abort.signal, (event) => {
            if (event.id !== undefined) lastId = event.id;
            const edge = feedStreamEdge(event, resume !== undefined);
            if (edge !== undefined) lastId = edge;
            onEvent(event);
          }, () => { failures = 0; });
        } catch { /* reconnects below */ }
        if (abort.signal.aborted) break;
        failures += 1;
        await sleep(Backoff.delay(failures) * 1000, abort.signal);
      }
    })();
  }

  stop(): void {
    this.abort?.abort();
    this.abort = undefined;
  }
}
