import { useEffect, useState } from 'react';
import { getBridge, type DesktopCommand } from '../../../bridge';

/** The last command native sent this panel (`desktop.onCommand`). */
export function useCommand(): DesktopCommand | null {
  const [command, setCommand] = useState<DesktopCommand | null>(null);
  useEffect(() => getBridge().desktop.onCommand(setCommand), []);
  return command;
}
