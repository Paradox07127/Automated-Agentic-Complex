import { useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from './Icon';
import styles from './CharacterArt.module.css';

/** Inside the app, or a local preview built with `VITE_EF_ART=1` and `/art` mounted; a plain browser has no art, and a 404 would log a console error. */
export function artEnabled(): boolean {
  return typeof window !== 'undefined' && (window.agenticComplex != null || import.meta.env.VITE_EF_ART === '1');
}

/** Page CSS shows its common/ decorations only under html[data-art]; an app built without art never gets it. */
export function markArt(): void {
  if (!artEnabled()) return;
  const probe = new Image();
  probe.onload = () => {
    document.documentElement.dataset.art = '';
  };
  probe.src = 'art/brand/emblem.png';
}
markArt();

/** 角色头像 / 立绘：有图时铺满裁切（头像顶对齐）；没有或读不出来时显示占位。 */
export interface CharacterArtProps {
  /** `CharacterEntry.head` / `.portrait` */
  src?: string | undefined;
  /** 头像或立绘 */
  kind: 'head' | 'portrait';
  /** 宽 */
  w: number;
  /** 高 */
  h: number;
  /** 占位 */
  fallback: ReactNode;
}

export function CharacterArt({ src, kind, w, h, fallback }: CharacterArtProps) {
  const [failed, setFailed] = useState<string>();
  const url = src !== failed ? src : undefined;
  if (!url && fallback == null) {
    return <span className={styles.fallback} data-stub="CharacterArt" />;
  }
  const size = { '--art-w': `${w}px`, '--art-h': `${h}px`, '--art-min': `${Math.min(w, h)}px` } as CSSProperties;
  if (!url) {
    return (
      <span className={styles.frame} data-stub="CharacterArt" data-kind={kind} style={size}>
        <span className={styles.fallback}>{fallback}</span>
      </span>
    );
  }
  return (
    <span className={styles.frame} data-stub="CharacterArt" data-kind={kind} style={size}>
      <img className={styles.art} data-kind={kind} src={url} width={w} height={h} alt="" onError={() => setFailed(url)} />
    </span>
  );
}

const HEAD =
  'data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 38 53"><rect width="38" height="53" fill="#3a3b3e"/><circle cx="19" cy="16" r="10" fill="#b3b3b3"/></svg>');

export const CharacterArtDemos: Array<{ name: string; props: CharacterArtProps }> = [
  { name: 'head', props: { src: HEAD, kind: 'head', w: 40, h: 40, fallback: <Icon name="user" size={24} /> } },
  { name: 'placeholder', props: { kind: 'head', w: 40, h: 40, fallback: <Icon name="user" size={24} /> } },
];
