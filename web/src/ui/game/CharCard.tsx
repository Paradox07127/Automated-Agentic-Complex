import type { ReactNode } from 'react';
import { CharacterArt } from '../CharacterArt';
import { Icon } from '../Icon';
import { Slab } from './Slab';
import { placeAt, type Box } from './WatchKey';
import styles from './CharCard.module.css';

/** 角色卡：深色斜切卡，左缘黄竖条，带框的头像，大号名字、英文名、她在做什么，再一行外观和帧率；点了去她的页面。紧凑款头像 44、名字小一号（菜单栏弹窗）。 */
export interface CharCardProps {
  /** 在舞台上的位置和大小 */
  box: Box;
  name: string;
  /** 英文名；没有时写 Operator；false 不画这一行 */
  en?: string | null | false;
  /** 头像图 */
  head?: string | null;
  /** 角色 id，没有头像图时按它画 */
  id?: string | null;
  /** 她在做什么 */
  doing?: string;
  /** 最后一行（外观、帧率）：`CharMeta` */
  meta?: ReactNode;
  /** 紧凑款 */
  compact?: boolean;
  onClick: () => void;
}

export function CharCard({ box, name, en, head, id, doing, meta, compact, onClick }: CharCardProps) {
  const notch = [[0, 0], [box.width - 14, 0], [box.width, 14], [box.width, box.height], [0, box.height]] as const;
  const size = compact ? 44 : 56;
  return (
    <button type="button" className={styles.char} {...placeAt(box)} aria-label={`角色：${name}`} onClick={onClick} data-g="home" data-compact={compact || undefined} data-stub="CharCard">
      <Slab pts={notch} w={box.width} h={box.height} depth={8} tone="dark">
        <span className={styles.charIn}>
          <span className={styles.charHead} aria-hidden="true">
            <CharacterArt src={head ?? undefined} id={id ?? undefined} art="card" kind="head" w={size} h={size} fallback={<Icon name="user" size={24} />} />
          </span>
          <span className={styles.charText}>
            <b className={styles.charName}>{name}</b>
            {en !== false && <span className={styles.charEn}>{en || 'Operator'}</span>}
            {doing && (
              <span className={styles.charDoing} title={doing}>
                {doing}
              </span>
            )}
            {meta}
          </span>
          <span className={styles.charGo} aria-hidden="true">
            <Icon name="chev" size={14} />
          </span>
        </span>
      </Slab>
    </button>
  );
}

/** 角色卡最后一行：她穿的外观和渲染帧率；不给帧率时只写外观，两样都没有时不画。 */
export function CharMeta({ outfit, fps }: { outfit: string | null; fps?: string }) {
  if (!outfit && fps == null) return null;
  return (
    <span className={styles.charMeta}>
      {outfit && <span className={styles.charOutfit}>{outfit}</span>}
      {fps != null && (
        <span className={styles.charFps}>
          <b>{fps}</b> FPS
        </span>
      )}
    </span>
  );
}

const noop = () => undefined;

export const CharCardDemos: Array<{ name: string; props: CharCardProps }> = [
  { name: 'home', props: { box: { width: 224, height: 76 }, name: '示例乙', en: 'Sample', doing: '正在看 Terminal', meta: <CharMeta outfit="夏装" fps="59" />, onClick: noop } },
  { name: 'compact', props: { box: { width: 320, height: 66 }, name: '示例乙', doing: '在桌面上 │ 空闲', compact: true, onClick: noop } },
  { name: 'outfit-only', props: { box: { width: 224, height: 76 }, name: '示例乙', doing: '正在看 Terminal', meta: <CharMeta outfit="夏装" />, onClick: noop } },
];
