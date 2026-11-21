// Chat: a speaker's round head sits before the name of the first of their consecutive messages only; never on the user's lines.
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../src/domain';
import { MessageList } from '../../src/pages/chat/MessageList';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const T = 1_700_000_000_000;
const MESSAGES: Message[] = [
  { kind: 'me', at: T, text: '你好' },
  { kind: 'ai', at: T + 1, text: '在', turn_ms: 1 },
  { kind: 'tool', at: T + 2, label: '读文件', ms: 10, summary: 'a.ts' },
  { kind: 'ai', at: T + 3, text: '读完了', turn_ms: 1 },
  { kind: 'ai', at: T + 4, text: '换我', turn_ms: 1, character_id: 'cedar' },
  { kind: 'side', at: T + 5, text: '旁路' },
  { kind: 'me', at: T + 6, text: '好' },
  { kind: 'me', at: T + 7, text: '再见' },
] as Message[];

const list = () =>
  render(
    <MessageList
      messages={MESSAGES}
      view={null}
      roleName="示例乙"
      roleId="si"
      names={{ cedar: '示例丙' }}
      now={T + 10}
      answered={{}}
      cancelled={{}}
      stopped={{}}
      frontTitle={null}
      turnOf={() => null}
      memsOf={() => ({ mems: [], learned: [] })}
      selTurn={null}
      onOpenDrawer={() => {}}
      onAnswer={() => {}}
      onCancelQuestion={() => {}}
      onQueueSide={() => {}}
      onTurn={() => {}}
    />,
  ).container;

const heads = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-ava]')].map((who) => who.children[1]?.textContent);

describe('chat speaker heads', () => {
  it('marks the first message of each run, across tool rows, and none of the user lines', () => {
    const c = list();
    expect(heads(c)).toEqual(['示例乙', '示例丙', '示例乙']);
    expect(c.querySelectorAll('[data-kind="me"] [data-ava]')).toHaveLength(0);
  });

  it('shows the placeholder in a plain browser and the bundled round art inside the app', () => {
    expect(list().querySelector('[data-ava] img')).toBeNull();
    cleanup();
    vi.stubEnv('VITE_EF_ART', '1');
    const srcs = [...list().querySelectorAll('[data-ava] img')].map((i) => i.getAttribute('src'));
    expect(srcs).toEqual(['art/characters/si/round.png', 'art/characters/cedar/round.png', 'art/characters/si/round.png']);
  });
});
