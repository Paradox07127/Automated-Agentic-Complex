/** How long her finished line stays in the bubble: 2 s + 120 ms a character, at most 12 s. */
export function sayMs(text: string): number {
  return Math.min(12_000, 2000 + 120 * [...text].length);
}
