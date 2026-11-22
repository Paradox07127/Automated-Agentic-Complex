import type { VisualShape } from '../../domain/states';

/** The shape of a state (domain/status.ts), 12 px in the current colour: the second channel beside the colour. */
export function StateGlyph({ shape, size = 12 }: { shape: VisualShape; size?: number }) {
  const body = {
    check: <path d="M2.5 6.4 5 8.9l4.6-5.3" fill="none" stroke="currentColor" strokeWidth="1.8" />,
    square: <rect x="2" y="2" width="8" height="8" fill="currentColor" />,
    triangle: <path d="M6 1.5 11 10.5H1z" fill="currentColor" />,
    diamond: <path d="M6 1 11 6 6 11 1 6z" fill="currentColor" />,
    ring: (
      <g fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="6" cy="6" r="4" opacity="0.3" />
        <path d="M6 2a4 4 0 0 1 4 4" data-spin="" />
      </g>
    ),
    dot: <circle cx="6" cy="6" r="2.5" fill="currentColor" />,
    'hollow-square': <rect x="2.25" y="2.25" width="7.5" height="7.5" fill="none" stroke="currentColor" strokeWidth="1.5" />,
  }[shape];
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" focusable="false" data-shape={shape}>
      {body}
    </svg>
  );
}
