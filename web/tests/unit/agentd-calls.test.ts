import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { AgentdCallError, BRIDGE_REFUSED, call, CONFLICT_CODES, del, get, patch, post, put, seg } from '../../src/bridge/agentd';
import type { MockRoute } from '../../src/mock/types';
import { classify, failText } from '../../src/data/tasksBase';

const echo = (method: MockRoute['method'], path: string): MockRoute => ({ method, path, handler: ({ body }) => ({ status: 200, body: { got: body ?? null } }) });

/** Fake bridge with extra routes, installed as `window.agenticComplex`; returns the request spy. */
function install(routes: MockRoute[] = []) {
  const bridge = createFakeBridge({ surface: 'main', still: true, routes });
  window.agenticComplex = bridge;
  return vi.spyOn(bridge.agentd, 'request');
}

async function thrown(p: Promise<unknown>): Promise<AgentdCallError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(AgentdCallError);
  return e as AgentdCallError;
}

afterEach(() => {
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('agentd call body defaults', () => {
  it('sends {} for POST, PUT and PATCH without a body', async () => {
    const spy = install([echo('POST', '/x'), echo('PUT', '/x'), echo('PATCH', '/x')]);
    expect(await post('/x')).toEqual({ got: {} });
    expect(await put('/x')).toEqual({ got: {} });
    expect(await patch('/x')).toEqual({ got: {} });
    expect(spy.mock.calls.map((c) => c[2])).toEqual([{}, {}, {}]);
  });

  it('keeps an explicit body', async () => {
    const spy = install([echo('POST', '/x')]);
    expect(await call('POST', '/x', { a: 1 })).toEqual({ got: { a: 1 } });
    expect(spy.mock.calls[0]?.[2]).toEqual({ a: 1 });
  });

  it('sends no body to the routes agentd does not read', async () => {
    const paths = ['/sessions/own%3Aabc/interrupt', '/tasks/t1/accept', '/tasks/t1/reject', '/commitments/c1/cancel', '/commitments/c1/complete'];
    const spy = install(paths.map((p) => echo('POST', p)));
    for (const p of paths) expect(await post(p), p).toEqual({ got: null });
    expect(spy.mock.calls.map((c) => c[2])).toEqual(paths.map(() => undefined));
  });

  it('still sends {} to look-alike routes that read the body', async () => {
    const paths = ['/tasks/t1/continue', '/tasks/t1/cancel', '/commitments/c1/snooze'];
    const spy = install(paths.map((p) => echo('POST', p)));
    for (const p of paths) await post(p);
    expect(spy.mock.calls.map((c) => c[2])).toEqual(paths.map(() => ({})));
  });

  it('sends DELETE without a body unless the caller passes one', async () => {
    const spy = install([echo('DELETE', '/x')]);
    expect(await del('/x')).toEqual({ got: null });
    expect(await del('/x', { expected_version: 2 })).toEqual({ got: { expected_version: 2 } });
    expect(spy.mock.calls.map((c) => c[2])).toEqual([undefined, { expected_version: 2 }]);
  });

  it('GET sends no body', async () => {
    const spy = install([echo('GET', '/x')]);
    await get('/x');
    expect(spy.mock.calls[0]?.[2]).toBeUndefined();
  });

  it('seg encodes one path segment but keeps the colon (/sessions matches `own:` literally)', () => {
    expect(seg('own:ab/c')).toBe('own:ab%2Fc');
    expect(seg('job:1a7e')).toBe('job:1a7e');
  });
});

describe('agentd call errors', () => {
  it('throws AgentdCallError with code, detail and the whole body on non-2xx', async () => {
    install([
      { method: 'POST', path: '/c', handler: () => ({ status: 409, body: { error: 'version_conflict', current_version: 3 } }) },
      { method: 'GET', path: '/d', handler: () => ({ status: 503, body: { error: 'no_memory', detail: '记忆没有开启', runtime: 'codex' } }) },
      { method: 'GET', path: '/e', handler: () => ({ status: 500, body: { ok: false } }) },
    ]);
    const c = await thrown(post('/c', { expected_version: 2 }));
    expect([c.status, c.code, c.detail, c.body]).toEqual([409, 'version_conflict', undefined, { error: 'version_conflict', current_version: 3 }]);
    expect(CONFLICT_CODES.has(c.code)).toBe(true);
    const d = await thrown(get('/d'));
    expect([d.status, d.code, d.detail, d.message]).toEqual([503, 'no_memory', '记忆没有开启', '记忆没有开启']);
    expect(d.body).toEqual({ error: 'no_memory', detail: '记忆没有开启', runtime: 'codex' });
    const e = await thrown(get('/e'));
    expect([e.status, e.code, e.body]).toEqual([500, 'http_500', { ok: false }]);
  });

  it('turns an unknown route into agentd 404 not_found', async () => {
    install();
    const e = await thrown(get('/nope'));
    expect([e.status, e.code, e.body]).toEqual([404, 'not_found', { error: 'not_found' }]);
  });

  it('tells offline apart from a bridge refusal', async () => {
    install([
      { method: 'GET', path: '/off', handler: () => ({ status: 0, body: null, error: { code: 'offline', detail: 'agentd is unreachable' } }) },
      { method: 'GET', path: '/host', handler: () => ({ status: 0, body: null, error: { code: 'route_class', detail: 'host_only' } }) },
    ]);
    const off = await thrown(get('/off'));
    const host = await thrown(get('/host'));
    expect([off.status, off.code, off.body]).toEqual([0, 'offline', null]);
    expect([host.status, host.code, host.body]).toEqual([0, 'route_class', null]);
    expect(BRIDGE_REFUSED.has(off.code)).toBe(false);
    expect(BRIDGE_REFUSED.has(host.code)).toBe(true);
  });
});

describe('fake agentd error shape', () => {
  it('answers an unknown route like agentd', async () => {
    const res = await createFakeBridge({ surface: 'main', still: true }).agentd.request('GET', '/nope');
    expect(res).toEqual({ status: 404, body: { error: 'not_found' }, error: { code: 'not_found' } });
  });

  it('answers 400 invalid_body_size when a write route gets no body', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true, routes: [echo('POST', '/x'), echo('POST', '/tasks/:id/accept')] });
    expect(await bridge.agentd.request('POST', '/x')).toEqual({ status: 400, body: { error: 'invalid_body_size' }, error: { code: 'invalid_body_size' } });
    expect((await bridge.agentd.request('POST', '/tasks/t1/accept')).status).toBe(200);
  });

  it('derives error from the handler body', async () => {
    const bridge = createFakeBridge({
      surface: 'main',
      still: true,
      routes: [{ method: 'GET', path: '/x', handler: () => ({ status: 409, body: { error: 'busy', detail: '忙' } }) }],
    });
    expect(await bridge.agentd.request('GET', '/x')).toEqual({ status: 409, body: { error: 'busy', detail: '忙' }, error: { code: 'busy', detail: '忙' } });
  });
});

describe('classify', () => {
  it('counts only code offline (or an offline agentd) as disconnected', () => {
    expect(classify({ status: 200 }, 'connected')).toBeNull();
    expect(classify({ status: 0, error: { code: 'offline' } }, 'connected')).toBe('disconnected');
    expect(classify({ status: 503 }, 'offline')).toBe('disconnected');
    expect(classify({ status: 0, error: { code: 'route_class', detail: 'host_only' } }, 'connected')).toBe('other');
    expect(classify({ status: 0, error: { code: 'surface_not_allowed' } }, 'connected')).toBe('other');
    expect(classify({ status: 404, error: { code: 'not_found' } }, 'connected')).toBe('not_found');
    expect(classify({ status: 500 }, 'connected')).toBe('other');
  });

  it('says why in words, never the code or an English detail', () => {
    expect(failText({ status: 0, body: null, error: { code: 'route_class', detail: 'host_only' } })).toBe('桌面端拒绝了这个请求');
    expect(failText({ status: 500, body: null, error: { code: 'internal', detail: 'boom' } })).toBe('后台出错了');
    expect(failText({ status: 400, body: null, error: { code: 'no_history', detail: '聊天记录没有开启' } })).toBe('尚未开启对话记录，无法读取或管理历史');
    expect(failText({ status: 400, body: null, error: { code: 'odd', detail: '聊天记录没有开启' } })).toBe('聊天记录没有开启');
  });
});
