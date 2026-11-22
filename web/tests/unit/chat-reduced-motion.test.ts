// jsdom does not compute specificity, so the reduced-motion rules are read as text: each must name the element the animating rule names.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(resolve(__dirname, '../../src/pages/chat', name), 'utf8');

/** The reduced-motion rules of a stylesheet: the media block and the in-app switch's rules. */
const stillRules = (css: string) => ({ media: css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)')), app: css.slice(css.indexOf(':global([data-reduce-motion])')) });

describe('chat reduced motion', () => {
  it('stops the current topic row stripes at the same specificity as the rule that draws them, with no pseudo-element inside :is()', () => {
    const css = read('ConvList.module.css');
    const { media, app } = stillRules(css);
    expect(css).not.toMatch(/:is\([^)]*::/);
    expect(media).toContain(".row[aria-current='true']::before");
    expect(app).toContain(".row[aria-current='true']::before");
  });

  it('stops the question options transition under both switches', () => {
    const css = read('QuestionCard.module.css');
    const { media, app } = stillRules(css);
    const option = ".qcard [role='listbox'] > :global([data-stub='OptionRow'])";
    expect(media).toContain(option);
    expect(app).toContain(option);
    expect(media).toMatch(/transition: none/);
    expect(app).toMatch(/transition: none/);
  });
});
