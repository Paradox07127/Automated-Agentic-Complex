import { useId } from 'react';
import styles from './DlgHead.module.css';

/** The dialog's title strip: two theme bars, the topic's name, the colour band at the right (prototype .hd). */
export function DlgHead({ title }: { title: string }) {
  // An id fit for url(#…): React's ids carry punctuation.
  const grad = `band${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <div className={styles.hd} data-g="head">
      <span className={styles.bars} aria-hidden="true">
        <i />
        <i />
      </span>
      <span className={styles.who}>{title}</span>
      <span className={styles.band} aria-hidden="true">
        <svg viewBox="0 0 420 58" preserveAspectRatio="xMaxYMid slice">
          <defs>
            <linearGradient id={grad} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fff" stopOpacity=".25" />
              <stop offset=".5" stopColor="#fff" stopOpacity="0" />
              <stop offset="1" stopColor="#000" stopOpacity=".15" />
            </linearGradient>
          </defs>
          <path d="M0 0h340v58H0z" fill="currentColor" />
          <path d="M0 0h340v58H0z" fill={`url(#${grad})`} />
          <g fill="var(--b-plate)">
            <rect x="0" y="0" width="14" height="14" />
            <rect x="14" y="14" width="14" height="14" />
            <rect x="0" y="28" width="14" height="14" />
            <rect x="14" y="42" width="14" height="16" />
          </g>
          <path d="M110 8h16v4h-10l16 16-3 3-16-16v10h-3z" fill="#0d3c6b" opacity=".85" />
          <g fill="#0d3c6b" opacity=".45">
            <circle cx="150" cy="18" r="1.3" />
            <circle cx="160" cy="18" r="1.3" />
            <circle cx="170" cy="18" r="1.3" />
            <circle cx="150" cy="30" r="1.3" />
            <circle cx="160" cy="30" r="1.3" />
            <circle cx="170" cy="30" r="1.3" />
            <circle cx="150" cy="42" r="1.3" />
            <circle cx="160" cy="42" r="1.3" />
          </g>
          <g fill="#1b2229">
            <circle cx="210" cy="20" r="10" />
            <path d="M194 52a16 14 0 0 1 32 0z" />
          </g>
          <g fill="currentColor">
            <rect x="194" y="41" width="32" height="2" />
            <rect x="194" y="46" width="32" height="2" />
          </g>
          <g fill="none" stroke="#1b2229" strokeWidth="3">
            <circle cx="242" cy="20" r="9" />
            <path d="M227 56v-4a15 13 0 0 1 30 0v4" />
          </g>
          <g fill="#1b2229">
            <rect x="276" y="5" width="2" height="48" />
            <rect x="281" y="5" width="4" height="48" />
            <rect x="288" y="5" width="1" height="48" />
            <rect x="292" y="5" width="3" height="48" />
            <rect x="298" y="5" width="1" height="48" />
            <rect x="302" y="5" width="5" height="48" />
            <rect x="311" y="5" width="2" height="48" />
          </g>
          <path d="M340 0h80v58h-80z" fill="var(--b-plate-hi)" />
          <g stroke="var(--b-t2)" strokeWidth="1.5">
            <path d="M352 6v8M348 10h8M352 44v8M348 48h8" />
            <path d="M388 14h16M390 20h12M388 26h16M390 32h12M388 38h16" />
          </g>
          <rect x="232" y="55" width="36" height="3" fill="#ff2bd6" />
          <rect x="272" y="55" width="36" height="3" fill="var(--b-sel)" />
          <rect x="312" y="55" width="28" height="3" fill="#fff" />
        </svg>
      </span>
    </div>
  );
}
