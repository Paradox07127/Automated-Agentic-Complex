import { useRef, useState, type MouseEvent } from 'react';
import { getBridge } from '../../bridge';
import type { RegionPoint } from '../../bridge/region';
import styles from './RegionRoot.module.css';

const at = (e: MouseEvent): RegionPoint => ({ x: e.clientX, y: e.clientY });

/** `stack.html#/region`: 框选给她看 (RegionSelectPanel). Native covers the screen under the pointer with the page and reads the
 *  region; the page dims the screen, draws the rect being dragged and hands native the press and the release. */
export function RegionRoot() {
  const start = useRef<RegionPoint | null>(null);
  const [drag, setDrag] = useState<{ from: RegionPoint; to: RegionPoint } | null>(null);
  const region = getBridge().region;

  const down = (e: MouseEvent) => {
    if (e.button === 2) return void region.cancel();
    if (e.button !== 0) return;
    start.current = at(e);
    setDrag({ from: at(e), to: at(e) });
  };
  const move = (e: MouseEvent) => {
    const from = start.current;
    if (from) setDrag({ from, to: at(e) });
  };
  const up = (e: MouseEvent) => {
    const from = start.current;
    start.current = null;
    setDrag(null);
    void (from ? region.finish(from, at(e)) : region.cancel());
  };

  const rect = drag && {
    left: Math.min(drag.from.x, drag.to.x),
    top: Math.min(drag.from.y, drag.to.y),
    width: Math.abs(drag.from.x - drag.to.x),
    height: Math.abs(drag.from.y - drag.to.y),
  };
  return (
    <div
      role="application"
      aria-label="框选"
      className={styles.root}
      onMouseDown={down}
      onMouseMove={move}
      onMouseUp={up}
      onContextMenu={(e) => e.preventDefault()}
    >
      {rect && <div data-rect className={styles.rect} style={rect} />}
    </div>
  );
}
