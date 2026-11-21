import { useEffect, useState } from 'react';
import { getBridge, type DesktopAnchor } from '../../../bridge';

/** Where native placed this panel. Subscribing on mount is also how native learns the page is alive. */
export function useAnchor(): DesktopAnchor | null {
  const [anchor, setAnchor] = useState<DesktopAnchor | null>(null);
  useEffect(() => getBridge().window.onAnchor(setAnchor), []);
  return anchor;
}
