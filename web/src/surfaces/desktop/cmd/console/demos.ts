// Menu bar preview states in stack.html#/console.
import { stackQuery } from '../../../stack/demos';

interface ConsoleDemo {
  /** Simulate the service being down while the browser bridge stays connected. */
  agentdDown?: boolean;
}

export const CONSOLE_DEMOS: Record<string, ConsoleDemo> = {
  console: {},
  'console-offline': { agentdDown: true },
};

export function consoleDemo(): ConsoleDemo {
  return CONSOLE_DEMOS[stackQuery().get('demo') ?? ''] ?? {};
}
