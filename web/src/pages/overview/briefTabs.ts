// 简报四个页签共用的接口和星标存储；总览读数带和明细页的星标读写同一份。
import { useCallback, useState } from 'react';
import { DEFAULT_PINS, ITEM_ORDER, type BriefDay, type BriefItemId } from './briefDay';

export type BriefTab = 'ov' | 'char' | 'tm' | 'dt';

/** Where a readout leads: `open` shows the items it counts, `to` ends its button's name. */
export interface ItemLink {
  open: () => void;
  to: string;
}

export interface BriefTabProps {
  day: BriefDay;
  /** 星标项，最多 6 个，按星标先后。 */
  pins: BriefItemId[];
  onPins: (next: BriefItemId[]) => void;
  /** 跳到另一个页签，例如总览里「看她这一天」。 */
  go: (tab: BriefTab) => void;
  /** Readouts that open what they count; one without a link stays a figure. */
  links: Partial<Record<BriefItemId, ItemLink>>;
}

const KEY = 'brief.pins';

function load(): BriefItemId[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!Array.isArray(v)) return DEFAULT_PINS;
    return v.filter((id): id is BriefItemId => ITEM_ORDER.includes(id as BriefItemId)).slice(0, 6);
  } catch {
    return DEFAULT_PINS;
  }
}

export function usePins(): [BriefItemId[], (next: BriefItemId[]) => void] {
  const [pins, set] = useState(load);
  const save = useCallback((next: BriefItemId[]) => {
    const v = next.slice(0, 6);
    set(v);
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
    } catch {
      // Storage off: the stars last while the page is open.
    }
  }, []);
  return [pins, save];
}
