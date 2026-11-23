import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getBridge } from '../../bridge';
import { useSystemTheme } from '../../shell/useSystemTheme';
import { stackQuery } from '../stack/demos';
import { ConsoleSlot } from './cmd/console/ConsoleSlot';
import { useAnchor } from './hooks/useAnchor';
import { useCommand } from './hooks/useCommand';
import { useContentSize } from './hooks/useContentSize';
import { useDesktopState } from './hooks/useDesktopState';
import { logInfo } from './hooks/useMountedLog';
import { usePresence } from './hooks/usePresence';
import { useRegions } from './hooks/useRegions';
import styles from './ConsoleRoot.module.css';

/** `stack.html#/console`: 控制台 under the menu bar item, in its own panel, opened and closed by its own native commands. */
export function ConsoleRoot() {
  const [q] = useState(stackQuery);
  const still = q.get('still') === '1';
  useSystemTheme(q.get('theme'));
  useEffect(() => {
    document.documentElement.classList.toggle('still', still);
  }, [still]);

  // The native host waits for this subscription even while the menu is closed.
  const anchor = useAnchor();
  const room = anchor?.room.height ?? 0;
  const shadowRoom = 12; // The root's 4 pt top and 8 pt bottom padding.
  const maxHeight = room > shadowRoom ? Math.floor(room) - shadowRoom : undefined;
  const state = useDesktopState();
  const presence = usePresence();
  const command = useCommand();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
    getBridge().window.close();
  }, []);
  useEffect(() => {
    if (command?.kind === 'openConsole') setOpen(true);
    else if (command?.kind === 'close') setOpen(false);
  }, [command]);
  // window.close only hides the panel; a card kept past it would show the panel again on its next resize.
  useEffect(
    () =>
      getBridge().window.onVisibility((visible) => {
        if (!visible) setOpen(false);
      }),
    [],
  );
  useLayoutEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [open, close]);

  const rootRef = useRef<HTMLDivElement>(null);
  useRegions(rootRef);
  useContentSize(rootRef);
  useEffect(() => {
    logInfo(`mounted console ${window.location.hash || '#/'}`);
  }, []);

  return (
    <div ref={rootRef} className={styles.root} data-surface-root="console">
      {open && <ConsoleSlot state={state} presence={presence} close={close} maxHeight={maxHeight} />}
    </div>
  );
}
