import { keyText } from '../../bridge/platformText';
import { Kbd } from '../../ui';

/** The bottom bar's key legend: `[↑][↓] 选择  [Enter] 修改 …`; a narrow or short window keeps the first two. */
export function Keys({ keys }: { keys: Array<[string[], string]> }) {
  return <Kbd variant="bar" held items={keys.map(([caps, what], i) => ({ keys: caps.map((c) => keyText(c)), label: what, ...(i >= 2 ? { more: true } : {}) }))} />;
}
