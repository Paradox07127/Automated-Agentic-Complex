import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Attached } from '../../src/surfaces/desktop/cmd/input/Attached';
import { dropOverflows, type Attachment } from '../../src/surfaces/desktop/cmd/input/selection';

// A drop's text goes with the next line to her, cut to the 2000 characters /say takes; 快速输入 says when it will be cut.

afterEach(cleanup);

const dropped = (text: string): Attachment => ({ kind: 'scope', files: 0, items: [{ kind: 'text', text }] });
const OVER = '拖入的内容太长，发送时只带前面一部分';

describe('dropOverflows', () => {
  it('is true when the drop would be cut, with or without what is typed', () => {
    expect(dropOverflows('', dropped('长'.repeat(2500)))).toBe(true);
    expect(dropOverflows('', dropped('长'.repeat(100)))).toBe(false);
    expect(dropOverflows('问'.repeat(1950), dropped('长'.repeat(100)))).toBe(true);
  });
});

describe('Attached', () => {
  const mount = (typed: string, text: string) =>
    render(<Attached attachment={dropped(text)} typed={typed} sending={false} onDrop={() => {}} onSend={() => {}} />);

  it('says a drop that will be cut is too long', () => {
    mount('问'.repeat(1950), '长'.repeat(100));
    screen.getByText(OVER);
  });

  it('says nothing of it while the drop fits', () => {
    mount('问', '长'.repeat(100));
    expect(screen.queryByText(OVER)).toBeNull();
  });
});
