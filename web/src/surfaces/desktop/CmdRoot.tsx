import { useEffect, useRef, useState, type ComponentType } from 'react';
import { getBridge, type CmdMode } from '../../bridge';
import { useSystemTheme } from '../../shell/useSystemTheme';
import { stackQuery } from '../stack/stackQuery';
import { RingSlot } from './cmd/ring/RingSlot';
import { useAnchor } from './hooks/useAnchor';
import { useCommand } from './hooks/useCommand';
import { useContentSize } from './hooks/useContentSize';
import { useDesktopState } from './hooks/useDesktopState';
import { useMountedLog } from './hooks/useMountedLog';
import { usePresence } from './hooks/usePresence';
import { useRegions } from './hooks/useRegions';
import type { CommandSlotProps } from './types';
import styles from './CmdRoot.module.css';

/** 快速输入 opens in the bubble (`#/bubble`), so an `input` open shows nothing here. */
const SLOTS: Partial<Record<CmdMode, ComponentType<CommandSlotProps>>> = { ring: RingSlot };

/** `stack.html#/cmd`: her wheel, opened and closed by native commands; 控制台 has its own panel. */
export function CmdRoot() {
  const [q] = useState(stackQuery);
  const still = q.get('still') === '1';
  useSystemTheme(q.get('theme'));
  useEffect(() => {
    document.documentElement.classList.toggle('still', still);
  }, [still]);

  const anchor = useAnchor();
  const state = useDesktopState();
  const presence = usePresence();
  const command = useCommand();
  const [mode, setMode] = useState<CmdMode | null>(null);
  useEffect(() => {
    if (command?.kind === 'open') setMode(command.mode);
    else if (command?.kind === 'close') setMode(null);
  }, [command]);
  // A native dismissal (outside click or panel reload) also clears the local layer.
  useEffect(
    () =>
      getBridge().window.onVisibility((visible) => {
        if (!visible) setMode(null);
      }),
    [],
  );

  const rootRef = useRef<HTMLDivElement>(null);
  useRegions(rootRef);
  useContentSize(rootRef);
  useMountedLog('cmd');

  const Slot = mode ? SLOTS[mode] : undefined;
  return (
    <div ref={rootRef} className={styles.root} data-surface-root="cmd" data-mode={mode ?? undefined}>
      {Slot && <Slot anchor={anchor} state={state} presence={presence} command={command} close={() => {
        setMode(null);
        getBridge().window.close();
      }} />}
    </div>
  );
}
