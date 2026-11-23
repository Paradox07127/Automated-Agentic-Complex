// Menu bar preview states in stack.html#/console?demo=<name>; the fake bridge reads the same names (`empty`: nothing
// waiting, `console-unread`: unread announcements).
import { stackQuery } from '../../../stack/demos';

interface ConsoleDemo {
  /** Simulate the service being down while the browser bridge stays connected. */
  agentdDown?: boolean;
  /** Simulate config.json failing to load, with this reason. */
  configError?: string;
}

export const CONSOLE_DEMOS: Record<string, ConsoleDemo> = {
  console: {},
  empty: {},
  'console-unread': {},
  'console-offline': { agentdDown: true },
  'console-config': { configError: 'config.json 第 12 行不是有效的 JSON' },
};

export function consoleDemo(): ConsoleDemo {
  return CONSOLE_DEMOS[stackQuery().get('demo') ?? ''] ?? {};
}
