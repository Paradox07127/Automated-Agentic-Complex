import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { getBridge, type Region } from '../../bridge';
import type { ResizeCorner, ResizeOverlayState } from '../../bridge/resize';
import { Btn } from '../../ui';
import { useRegions } from './hooks/useRegions';
import { BRACKET_OUTSET, CORNERS, cornerPoint, isRight, isTop, percentText, resizeLayout, rulerPosition } from './resizeLayout';
import styles from './ResizeRoot.module.css';

/** AvatarResizeOverlayFace.handleHit: the hit area around the 14 pt dot. */
const HANDLE_HIT = 24;
/** The bracket's arms. */
const BRACKET_ARM = 7;
const RULER_WIDTH = 40;

function bracketStyle(c: ResizeCorner, f: Region) {
  return {
    left: isRight(c) ? f.x + f.width + BRACKET_OUTSET - BRACKET_ARM : f.x - BRACKET_OUTSET,
    top: isTop(c) ? f.y - BRACKET_OUTSET : f.y + f.height + BRACKET_OUTSET - BRACKET_ARM,
  };
}

/** `stack.html#/resize`: 调整大小 (AvatarResizeOverlayView). Native covers her screen with the page and owns her size; the page
 *  draws the brackets, the four handles, the percentage chip and the 恢复默认 / 取消 / 完成 bar, and sends the drags and the buttons.
 *  Esc is 取消: her size goes back to what it was before this session. */
export function ResizeRoot() {
  const ref = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ResizeOverlayState | null>(null);
  const [sizes, setSizes] = useState({ chip: { width: 0, height: 0 }, bar: { width: 0, height: 0 } });
  useEffect(() => getBridge().resize.onState(setState), []);
  // The shell takes Esc itself once the panel has the keyboard; this covers the page when the key reaches it.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      void getBridge().resize.act('cancel');
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useRegions(ref);
  useLayoutEffect(() => {
    const c = chip.current, b = bar.current;
    if (!c || !b) return;
    if (c.offsetWidth !== sizes.chip.width || c.offsetHeight !== sizes.chip.height || b.offsetWidth !== sizes.bar.width
      || b.offsetHeight !== sizes.bar.height) {
      setSizes({ chip: { width: c.offsetWidth, height: c.offsetHeight }, bar: { width: b.offsetWidth, height: b.offsetHeight } });
    }
  });
  const resize = getBridge().resize;

  // DragGesture(minimumDistance: 0): the press already starts the drag.
  const press = (corner: ResizeCorner) => (e: MouseEvent) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    void resize.drag(corner, 0, 0);
    const move = (m: globalThis.MouseEvent) => void resize.drag(corner, m.clientX - start.x, m.clientY - start.y);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      void resize.endDrag();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  if (!state) return <div ref={ref} className={styles.root} />;
  const { frame, scale, limit, dragging } = state;
  const layout = resizeLayout(frame, { width: window.innerWidth, height: window.innerHeight }, sizes.chip, sizes.bar);
  const percent = percentText(scale);
  return (
    <div ref={ref} className={styles.root} data-theme="dark" data-dragging={dragging ?? undefined}>
      {CORNERS.map((c) => (
        <span key={c} aria-hidden="true" className={`${styles.bracket} ${styles[c]}`} style={bracketStyle(c, frame)} />
      ))}
      {CORNERS.map((c) => {
        const p = cornerPoint(c, frame);
        return (
          <div
            key={c}
            role="slider"
            aria-label="调整大小手柄"
            aria-valuenow={Math.round(scale * 100)}
            aria-valuemin={50}
            aria-valuemax={200}
            aria-valuetext={percent}
            className={styles.handle}
            data-region
            data-limit={limit ?? undefined}
            data-active={limit === null && dragging === c ? '' : undefined}
            style={{ left: p.x - HANDLE_HIT / 2, top: p.y - HANDLE_HIT / 2 }}
            onMouseDown={press(c)}
          >
            <span className={styles.dot} />
          </div>
        );
      })}
      <div ref={chip} role="group" aria-label="大小" className={styles.chip} style={{ left: layout.chip.x, top: layout.chip.y }}>
        <span className={styles.percent}>{percent}</span>
        <span className={styles.ruler} aria-hidden="true">
          <span className={styles.track} />
          <span className={styles.fill} style={{ width: RULER_WIDTH * rulerPosition(scale) }} />
          <span className={styles.tick} style={{ left: RULER_WIDTH * rulerPosition(1) - 0.5 }} />
        </span>
        {limit && <span className={styles.limit}>{limit === 'min' ? '最小' : '最大'}</span>}
      </div>
      <div ref={bar} role="toolbar" className={styles.bar} data-region style={{ left: layout.bar.x, top: layout.bar.y }}>
        <Btn size="sm" variant="secondary" onClick={() => void resize.act('restoreDefault')}>
          恢复默认
        </Btn>
        <Btn size="sm" variant="secondary" kbd="esc" onClick={() => void resize.act('cancel')}>
          取消
        </Btn>
        <Btn size="sm" variant="primary" onClick={() => void resize.act('done')}>
          完成
        </Btn>
      </div>
    </div>
  );
}
