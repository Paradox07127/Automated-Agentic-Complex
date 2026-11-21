import type { AgenticComplexBridge } from '../../bridge';

/** 「在终端运行」: runs it when the shell can (`capabilities.runInTerminal`), otherwise copies it to paste. */
export async function runInTerminal(bridge: AgenticComplexBridge, command: string): Promise<'ran' | 'copied'> {
  if (bridge.capabilities.runInTerminal) {
    await bridge.open.runInTerminal(command);
    return 'ran';
  }
  await bridge.clipboard.writeText(command);
  return 'copied';
}
