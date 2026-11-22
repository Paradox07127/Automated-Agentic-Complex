// Chat: a speaker's round head sits on the first of their consecutive messages only; the user's lines get the plain figure.
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '../../src/domain';
import { MessageList } from '../../src/pages/chat/MessageList';

afterEach(cleanup);

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

const list = (headUrl?: string) =>
  render(
    <MessageList
      messages={MESSAGES}
      view={null}
      roleName="乙乙"
      roleId="si"
      names={{ cedar: '丙丙' }}
      {...(headUrl ? { headUrl } : {})}
      now={T + 10}
      answered={{}}
      cancelled={{}}
      stopped={{}}
      frontTitle={null}
      memsOf={() => ({ mems: [], learned: [] })}
      onOpenDrawer={() => {}}
      onAnswer={() => {}}
      onCancelQuestion={() => {}}
      onQueueSide={() => {}}
    />,
  ).container;

/** Each head of her side, by what it shows: its picture's src, else the name's first character. */
const heads = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-kind="ai"] [data-head], [data-kind="side"] [data-head]')].map((h) => h.querySelector('img')?.getAttribute('src') ?? h.textContent);

describe('chat speaker heads', () => {
  it('marks the first message of each run, across tool rows', () => {
    expect(heads(list())).toEqual(['乙', '丙', '乙']);
  });

  it('shows her head picture on her lines and the name’s first character on another speaker’s', () => {
    expect(heads(list('/head/si.png'))).toEqual(['/head/si.png', '丙', '/head/si.png']);
  });

  it('gives the user lines the plain figure, never a name or a picture', () => {
    const c = list('/head/si.png');
    const mine = [...c.querySelectorAll<HTMLElement>('[data-kind="me"] [data-head]')];
    expect(mine).toHaveLength(2);
    for (const h of mine) {
      expect(h.querySelector('img')).toBeNull();
      expect(h.textContent).toBe('');
    }
  });
});
