/** Game colours of the effect kit, each a `--ef-*` token. */
export type FxTone = 'yellow' | 'ring-yellow' | 'lemon' | 'techline' | 'cyan' | 'white' | 'ring' | 'reddot';

const TOKEN: Record<FxTone, string> = {
  yellow: 'g-yellow',
  'ring-yellow': 'g-ring-yellow',
  lemon: 'accent',
  techline: 'g-techline',
  cyan: 'g-cyan',
  white: 'g-btn-hover',
  ring: 'g-ring-3',
  reddot: 'g-reddot',
};

export function toneVar(tone: FxTone): string {
  return `var(--ef-${TOKEN[tone]})`;
}

/** A sprite the app bundles under /art (e.g. `watch/ui-out-ring`), as a CSS image. */
export function artUrl(sprite: string): string {
  return `url('/art/${sprite}.png')`;
}
