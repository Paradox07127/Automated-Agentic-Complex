// `desktop.say` (src/common/desktop-say.ts): the returns/desktop.json fixtures' shapes, `/say`'s body, and each kind of
// refusal.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { mismatches } from '../../../web/tests/unit/shape.ts';
import { BridgeFailure } from '../src/common/bridge.ts';
import { parseSay, say, sayBody } from '../src/common/desktop-say.ts';
import { TurnMarks } from '../src/common/turn-marks.ts';

const fixtures = JSON.parse(readFileSync(new URL('../../../protocol/ui-bridge/returns/desktop.json', import.meta.url), 'utf8')) as
  { op: string; args: unknown[]; value: unknown }[];

const answering = (status: number, body: unknown) => async () => ({ status, body: JSON.stringify(body) });

test('the returns fixtures\' shapes: a line agentd took is ok, a refusal is ok false with its reason', async () => {
  const [sent, refused] = fixtures.filter((f) => f.op === 'desktop.say');
  const ok = await say(parseSay(sent!.args[0]), answering(202, { line_id: 'l1', generation: 1 }), () => {});
  assert.deepEqual(mismatches(sent!.value, ok, [], []), []);
  const no = await say(parseSay({ text: 'x', attachWindow: false, noMemory: true }), answering(400, { error: 'invalid_text' }), () => {});
  assert.deepEqual(mismatches(refused!.value, { ok: no.ok, reason: (no as { reason: string }).reason }, [], []), []);
  // The empty text is refused before agentd sees it.
  assert.throws(() => parseSay(refused!.args[0]), (e) => e instanceof BridgeFailure && e.code === 'invalid_args');
});

test('the body is AgentdClient.say\'s: a window to read replaces look, the rest only when given', () => {
  assert.deepEqual(sayBody(parseSay({ text: '你好', attachWindow: true, noMemory: false })), { text: '你好', source: 'text', look: true });
  assert.deepEqual(sayBody(parseSay({ text: '你好', attachWindow: true, noMemory: true, scopeId: 's1', surface: 'quick_input',
    quote: { text: '选中的', app: null }, replyTo: { kind: 'line', id: 'l9' }, lookWindow: { windowId: 812, pid: 4242 } })), {
    text: '你好', source: 'text', no_memory: true, look_window: { window_id: 812, pid: 4242 }, scope_id: 's1', surface: 'quick_input',
    quote: { text: '选中的', app: null }, reply_to: { kind: 'line', id: 'l9' },
  });
});

test('arguments the bridge refuses are invalid_args', () => {
  const base = { text: 'x', attachWindow: false, noMemory: false };
  for (const bad of [null, { ...base, text: '  ' }, { ...base, text: 'x'.repeat(2001) }, { ...base, noMemory: 1 },
    { ...base, scopeId: '' }, { ...base, surface: 'menu' }, { ...base, quote: { text: '' } }, { ...base, replyTo: { kind: 'card', id: 'a' } },
    { ...base, lookWindow: { windowId: 0, pid: 1 } }, { ...base, lookWindow: { windowId: 1, pid: 1.5 } }]) {
    assert.throws(() => parseSay(bad), (e) => e instanceof BridgeFailure && e.code === 'invalid_args', JSON.stringify(bad));
  }
  assert.equal(parseSay({ ...base, text: '佩'.repeat(2000) }).text.length, 2000);
  assert.equal(parseSay({ ...base, text: `${'佩'.repeat(2000)}\n\n`, quote: { text: ` ${'x'.repeat(2000)} ` } }).text.length, 2002,
    'the limit counts the text without its surrounding whitespace, as agentd does');
});

test('a runtime refusal is kernel with its fix, another is rejected with the bar\'s line, no answer is agentd', async () => {
  const r = parseSay({ text: 'x', attachWindow: false, noMemory: false });
  const lines: string[] = [];
  assert.deepEqual(await say(r, answering(503, { error: 'native_login_required', runtime: 'codex' }), (l) => lines.push(l)),
    { ok: false, reason: 'kernel', detail: '在终端运行 codex login，完成后到 设置 › 内核 点「重新检测」再发' });
  assert.deepEqual(await say(r, answering(409, { error: 'switching' }), () => {}),
    { ok: false, reason: 'rejected', detail: '她正在换角色，这条没收下' });
  assert.deepEqual(await say(r, answering(418, { error: 'teapot' }), () => {}),
    { ok: false, reason: 'rejected', detail: 'agentd 没收下这条（418 teapot）' });
  assert.deepEqual(await say(r, async () => { throw new Error('ECONNREFUSED'); }, () => {}), { ok: false, reason: 'agentd' });
  assert.deepEqual(await say(r, answering(200, { command: 'stop' }), () => {}), { ok: true });
  assert.deepEqual(lines, ['QUICKINPUT web say chars=1 attach=false no_memory=false status=503']);
});

test('a send carries one Idempotency-Key; a dropped connection is sent once more with it, two drops are agentd', async () => {
  const r = parseSay({ text: 'x', attachWindow: false, noMemory: false });
  const keys: string[] = [];
  let tries = 0;
  const flaky = async (_m: string, _p: string, _j: unknown, headers: Record<string, string>) => {
    keys.push(headers['Idempotency-Key']!);
    tries += 1;
    if (tries === 1) throw new Error('socket hang up');
    return { status: 202, body: JSON.stringify({ line_id: 'l1' }) };
  };
  assert.deepEqual(await say(r, flaky, () => {}), { ok: true });
  assert.equal(keys.length, 2);
  assert.match(keys[0]!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(keys[1], keys[0]);
  keys.length = 0;
  const down = async (_m: string, _p: string, _j: unknown, headers: Record<string, string>) => {
    keys.push(headers['Idempotency-Key']!);
    throw new Error('ECONNREFUSED');
  };
  assert.deepEqual(await say(r, down, () => {}), { ok: false, reason: 'agentd' });
  assert.equal(keys.length, 2, 'one retry, not more');
  assert.equal(keys[1], keys[0]);
});

test('a line agentd took marks ui.submitted with the moment it was sent, then ui.ack', async () => {
  const r = parseSay({ text: 'x', attachWindow: false, noMemory: false });
  const marks: [string, string, string, number][] = [];
  const turnMarks = new TurnMarks((kind, trace, turn, generation) => marks.push([kind, trace, turn, generation]));
  await say(r, answering(202, { line_id: 'l1', trace_id: 't1', generation: 3 }), () => {}, turnMarks);
  await say(r, answering(409, { error: 'switching' }), () => {}, turnMarks);
  assert.deepEqual(marks, [['ui.submitted', 't1', 'l1', 3], ['ui.ack', 't1', 'l1', 3]]);
});
