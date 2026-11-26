// HelperConnection's own checks of the helper wire (src/main/helper/client.ts), with no helper process: the line limit for requests
// and the event seq.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HelperConnection, type HelperEvent, MAX_LINE_BYTES } from '../src/main/helper/client.ts';

test('a request longer than max_line_bytes is refused here and never written', async () => {
  const written: string[] = [];
  const connection = new HelperConnection({ write: (line) => written.push(line), onBroken: () => {} });
  const reply = await connection.request('screens.list', { blob: 'x'.repeat(MAX_LINE_BYTES) });
  assert.equal(reply.ok ? '' : reply.error.code, 'bad_request');
  assert.deepEqual([written.length, connection.inFlight], [0, 0]);
});

test('an event whose seq does not increase from 1 breaks the connection', () => {
  for (const seqs of [[0], [-1], [1, 1], [2, 1]]) {
    const events: number[] = [], broken: string[] = [];
    const connection = new HelperConnection({ write: () => {}, onBroken: (r) => broken.push(r),
      onEvent: (e: HelperEvent) => events.push(e.seq) });
    connection.helloEvents = ['input.mouse_down'];
    for (const seq of seqs) connection.feed(Buffer.from(`${JSON.stringify({ v: 1, event: 'input.mouse_down', seq, data: {} })}\n`));
    assert.deepEqual([events, broken.length], [seqs.slice(0, -1), 1], JSON.stringify(seqs));
  }
});

test('events with seq 1, 2, 5 are delivered', () => {
  const events: number[] = [], broken: string[] = [];
  const connection = new HelperConnection({ write: () => {}, onBroken: (r) => broken.push(r), onEvent: (e) => events.push(e.seq) });
  connection.helloEvents = ['input.mouse_down'];
  for (const seq of [1, 2, 5]) connection.feed(Buffer.from(`${JSON.stringify({ v: 1, event: 'input.mouse_down', seq, data: {} })}\n`));
  assert.deepEqual([events, broken], [[1, 2, 5], []]);
});
