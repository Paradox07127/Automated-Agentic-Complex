import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { StreamEvent } from '../../src/bridge';
import { chatStream } from '../../src/pages/chat/stream';
import { useChatFeed } from '../../src/pages/chat/useChatFeed';

afterEach(() => { cleanup(); delete window.agenticComplex; });

it('auto allowance events become tool rows only in their conversation', () => {
  let listener: (event: StreamEvent) => void = () => {};
  const bridge = createFakeBridge({ surface: 'main', still: true });
  bridge.feed.subscribe = (onEvent) => { listener = onEvent; return () => {}; };
  window.agenticComplex = bridge;
  const handlers = { turns: vi.fn(), tasks: vi.fn(), reload: vi.fn() };
  const { result, rerender } = renderHook(({ conv }) => useChatFeed(conv, handlers), { initialProps: { conv: 'c1' } });
  const send = (conv: string) => listener({ event: 'agent_interaction', id: '1', data: JSON.stringify({
    state: 'allowed_session', session_allowed: true, conversation_id: conv,
    run_id: 'run', tool: 'send', server: 'remote', at: 100,
  }) });
  act(() => { send('c2'); send('c1'); });
  expect(result.current.allowedTools).toEqual([{ kind: 'tool', at: 100000, label: 'remote/send', ms: 0, summary: '', sessionAllowed: true }]);
  expect(chatStream([{ kind: 'me', at: 99999, text: 'start' }, { kind: 'ai', at: 100001, text: 'done', turn_ms: 1 }], [], [], result.current.allowedTools).map((m) => m.kind)).toEqual(['me', 'tool', 'ai']);
  rerender({ conv: 'c2' });
  expect(result.current.allowedTools).toEqual([]);
});
