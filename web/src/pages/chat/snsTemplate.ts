// Mixed chat template: a reply stays a chat bubble while it is short plain text, else it becomes a full-width content card.

const FENCE = /^```/m;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m;
const HEADING = /^#{1,6}\s+/m;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/;
const QUOTE = /^\s*>\s?/m;
const BULLET = /^(?:\s*[-*+]\s+|\s*\d+[.)]\s+)/;
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯　-〿]/;

/** Bubble text width 381 px at 13 px: 29 CJK characters a line, a Latin character counting 0.55. */
const UNITS_PER_LINE = 29;
const MAX_LINES = 6;

function longList(text: string): boolean {
  let run = 0;
  for (const line of text.split('\n')) {
    run = BULLET.test(line) ? run + 1 : line.trim() === '' ? run : 0;
    if (run > 3) return true;
  }
  return false;
}

function lines(text: string): number {
  return text.split('\n').reduce((sum, p) => {
    if (p.trim() === '') return sum;
    let units = 0;
    for (const ch of p) units += CJK.test(ch) ? 1 : 0.55;
    return sum + Math.max(1, Math.ceil(units / UNITS_PER_LINE));
  }, 0);
}

/** True when the text fits the chat bubble: no block content and at most six lines. */
export function fitsBubble(text: string): boolean {
  const t = text.trim();
  if (FENCE.test(t) || TABLE_DIVIDER.test(t) || HEADING.test(t) || IMAGE.test(t) || QUOTE.test(t) || longList(t)) return false;
  return lines(t) <= MAX_LINES;
}
