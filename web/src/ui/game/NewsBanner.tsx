import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { Diamond } from './Marks';
import { Slab, unit, type Pt } from './Slab';
import { placeAt, type Box } from './WatchKey';
import styles from './NewsBanner.module.css';

/** 横幅里的一条。 */
export interface NewsItem {
  /** 种类：提醒、交付、播报 */
  kind: string;
  title: string;
  /** 时间，照来源页的写法 */
  at: string;
  go: () => void;
}

/** 消息横幅（游戏 BannerNode）：深色卡、左缘黄光，种类黄块和时间在上、标题在下，一次一条，6 秒自动翻，两侧箭头和页点手动翻。给了 `count` 是未读播报：写「第几 / 共几 未读」，右上「全部已读」。 */
export interface NewsBannerProps {
  /** 在舞台上的位置和大小 */
  box: Box;
  items: readonly NewsItem[];
  /** 不自动翻（截图、减少动效） */
  still?: boolean;
  /** 未读总数 */
  count?: number;
  /** 全部标为已读 */
  onReadAll?: () => void;
}

/** The banner sprite's outline, traced from its alpha edge, in a unit box. */
const OUTLINE: readonly Pt[] = [[0.062, 0.029], [0.033, 0.058], [0.016, 0.099], [0.008, 0.145], [0.008, 0.860], [0.022, 0.924], [0.041, 0.959], [0.062, 0.977], [0.943, 0.983], [0.967, 0.959], [0.986, 0.913], [0.992, 0.878], [0.992, 0.140], [0.981, 0.087], [0.943, 0.029]];

/** How long each item stays, as the game's banner turns. */
const NEWS_MS = 6000;

export function NewsBanner({ box, items, still = false, count, onReadAll }: NewsBannerProps) {
  const [i, setI] = useState(0);
  // Turning by hand restarts the wait, so the item just picked stays its full time.
  const [turned, setTurned] = useState(0);
  // Under the pointer, a press or focus it holds still, so a click opens the item it was aimed at; leaving restarts the wait.
  const [hover, setHover] = useState(false);
  const [press, setPress] = useState(false);
  const [focus, setFocus] = useState(false);
  const held = hover || press || focus;
  useEffect(() => {
    if (!press) return;
    const up = () => setPress(false);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [press]);
  useEffect(() => {
    if (still || held || items.length < 2) return;
    const t = window.setInterval(() => setI((v) => v + 1), NEWS_MS);
    return () => window.clearInterval(t);
  }, [still, held, items.length, turned]);
  const n = Math.max(items.length, 1);
  const at0 = ((i % n) + n) % n;
  const item = items[at0];
  const step = (d: 1 | -1) => {
    setI((v) => v + d);
    setTurned((v) => v + 1);
  };
  const unread = count == null ? null : count > 1 ? `${at0 + 1} / ${count} 未读` : '未读';
  return (
    <div
      className={styles.bannerNode}
      {...placeAt(box)}
      data-g="banner"
      data-stub="NewsBanner"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={() => setPress(true)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocus(false)}
    >
      <Slab pts={unit(OUTLINE, box.width, box.height)} w={box.width} h={box.height} depth={7} tone="dark" accent>
        <button type="button" className={styles.banner} onClick={item?.go} disabled={!item} aria-label={item ? `${item.kind}：${item.title} ${item.at}${unread ? ` ${unread}` : ''}` : '没有新消息'}>
          <span className={styles.bannerIn} aria-hidden="true">
            {item ? (
              <>
                <span className={styles.news}>
                  {unread && <Diamond size={8} />}
                  <b>{item.kind}</b>
                  <span className="num">{item.at}</span>
                  {unread && <span className={styles.count}>{unread}</span>}
                </span>
                <span className={styles.newsTitle}>{item.title}</span>
              </>
            ) : (
              <span className={styles.newsCalm}>没有新消息</span>
            )}
          </span>
        </button>
        {onReadAll && item && (
          <button type="button" className={styles.readAll} onClick={onReadAll}>
            <Icon name="check" size={14} />
            全部已读
          </button>
        )}
        {items.length > 1 && (
          <span className={styles.pages}>
            <button type="button" className={styles.turn} aria-label="上一条" onClick={() => step(-1)}>
              <Icon name="chev" size={12} />
            </button>
            {items.map((x, j) => (
              <i key={`${x.kind}-${j}`} data-on={j === at0 || undefined} />
            ))}
            <button type="button" className={styles.turn} aria-label="下一条" onClick={() => step(1)}>
              <Icon name="chev" size={12} />
            </button>
          </span>
        )}
      </Slab>
    </div>
  );
}

const noop = () => undefined;
const NEWS: NewsItem[] = [
  { kind: '提醒', title: '15:30 和设计组对一下评审', at: '15:30', go: noop },
  { kind: '交付', title: '整理构建脚本：测试全部通过', at: '14:02', go: noop },
];

export const NewsBannerDemos: Array<{ name: string; props: NewsBannerProps }> = [
  { name: 'home', props: { box: { width: 236, height: 60 }, items: NEWS, still: true } },
  { name: 'empty', props: { box: { width: 236, height: 60 }, items: [], still: true } },
  {
    name: 'unread',
    props: { box: { width: 320, height: 70 }, items: [{ kind: '播报', title: '构建跑完了，3 个测试没过', at: '14:21', go: noop }, ...NEWS], still: true, count: 3, onReadAll: noop },
  },
];
