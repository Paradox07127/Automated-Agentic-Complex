import { useEffect, useRef } from 'react';
import type { Delivery } from '../../domain';

export type DeliveryReceiptKind = 'presented' | 'viewed';
export type OnDeliveryReceipt = (id: string, kind: DeliveryReceiptKind) => void;

/** A mount alone is not presentation: require an intersecting element in a visible document. */
export function useDeliveryVisibility<T extends HTMLElement = HTMLDivElement>(delivery: Delivery | null, receipt: OnDeliveryReceipt | undefined, kind: DeliveryReceiptKind) {
  const ref = useRef<T>(null);
  const id = delivery && !delivery.redacted ? delivery.id : null;
  useEffect(() => {
    const node = ref.current;
    if (!node || !id || !receipt || typeof IntersectionObserver === 'undefined') return;
    let intersecting = false;
    const report = () => {
      if (intersecting && document.visibilityState === 'visible') receipt(id, kind);
    };
    const observer = new IntersectionObserver((entries) => {
      intersecting = entries.some((e) => e.target === node && e.isIntersecting && e.intersectionRatio > 0);
      report();
    });
    observer.observe(node);
    document.addEventListener('visibilitychange', report);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', report); };
  }, [id, delivery?.revision, receipt, kind]);
  return ref;
}
