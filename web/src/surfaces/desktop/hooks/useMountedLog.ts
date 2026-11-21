import { useEffect } from 'react';

/** Writes one info line to the shell's ui.log through `window.logInfo`; nothing outside the shell. */
export function logInfo(message: string) {
  try {
    window.agenticComplex?.window.logInfo(message);
  } catch {
    // A torn-down handler drops the line.
  }
}

/** `mounted <surface> <route>` once the desktop entry has mounted. */
export function useMountedLog(surface: 'cmd' | 'bubble' | 'hud' | 'ring') {
  useEffect(() => {
    logInfo(`mounted ${surface} ${window.location.hash || '#/'}`);
  }, [surface]);
}
