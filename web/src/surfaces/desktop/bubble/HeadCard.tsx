import { useState } from 'react';
import { artSrc } from '../../../ui/CharacterArt';
import styles from './Bubble.module.css';

/** The radio icon with its two arcs: the sprites once the art is in place, else the SVG. */
export function RadioIcon({ className, arcs = false }: { className?: string; arcs?: boolean }) {
  return (
    <span className={`${styles.radioIcon} ${className ?? ''}`} aria-hidden="true">
      <svg viewBox={arcs ? '0 0 22 21' : '0 0 12 21'}>
        <g fill="none" stroke="currentColor" strokeLinecap="round">
          <path d="M3.5 1v4" strokeWidth="1.4" />
          <rect x="1.2" y="5.2" width="9.6" height="14.6" rx="1.5" strokeWidth="1.4" />
          <path d="M3.8 9.5h4.4M3.8 12h4.4" strokeWidth="1.2" />
        </g>
        {arcs && (
          <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
            <path d="M14 9.5a3 3 0 0 1 0 4" />
            <path d="M16.5 7.5a6 6 0 0 1 0 8" />
          </g>
        )}
      </svg>
      <i className={styles.radioBody} />
      {arcs && <i className={styles.radioArcs} />}
    </span>
  );
}

/** The head card beside her line: dot tile, vignette, her comm portrait with a soft bottom edge, corner dots, deco line, radio icon; without the art or when it fails, the card shows no portrait. */
export function HeadCard({ id }: { id?: string | null | undefined }) {
  const src = artSrc(id, 'comm');
  const [failed, setFailed] = useState<string | undefined>(undefined);
  return (
    <span className={styles.headCard} aria-hidden="true">
      <i className={styles.headTile} />
      {src && src !== failed && <img className={styles.headArt} src={src} alt="" onError={() => setFailed(src)} />}
      <RadioIcon className={styles.headRadio} arcs />
    </span>
  );
}
