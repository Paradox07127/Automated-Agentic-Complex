// Screenshot-able desktop panel states: open `stack.html#<path>?<params>` (plus `still=1`, `theme=light|dark`).
// The fake bridge reads `demo=` for the anchor, desktop state and presence, `mode=` for the layer the cmd page opens
// (`mode=input`: 快速输入 in the bubble) and `dock=` for her hover buttons. `demo=chip-offline` takes agentd away on any
// panel, `plugins=light_ai` leaves 屏幕识读 off, and `demo=logged-out` leaves no model.
// Pure data so an e2e spec can import the list.

export type DesktopPath = '/cmd' | '/console' | '/bubble' | '/hud' | '/chip' | '/dock';

export interface DesktopDemo {
  name: string;
  path: DesktopPath;
  params: Record<string, string>;
}

export const DESKTOP_DEMOS: DesktopDemo[] = [
  { name: 'cmd-ring', path: '/cmd', params: { mode: 'ring' } },
  { name: 'console-panel', path: '/console', params: {} },
  { name: 'console-panel-offline', path: '/console', params: { demo: 'console-offline' } },
  { name: 'bubble-thought', path: '/bubble', params: { demo: 'thought' } },
  { name: 'bubble-speech', path: '/bubble', params: { demo: 'speech' } },
  { name: 'bubble-reminder', path: '/bubble', params: { demo: 'reminder' } },
  { name: 'bubble-done', path: '/bubble', params: { demo: 'done' } },
  { name: 'bubble-error', path: '/bubble', params: { demo: 'error' } },
  { name: 'bubble-look', path: '/bubble', params: { demo: 'look' } },
  { name: 'bubble-confirm', path: '/bubble', params: { demo: 'confirm' } },
  { name: 'bubble-input', path: '/bubble', params: { mode: 'input' } },
  { name: 'bubble-input-offline', path: '/bubble', params: { mode: 'input', demo: 'chip-offline' } },
  { name: 'bubble-input-nomodel', path: '/bubble', params: { mode: 'input', demo: 'logged-out' } },
  { name: 'bubble-hidden', path: '/bubble', params: { demo: 'hidden' } },
  { name: 'chip-waiting', path: '/chip', params: { dock: 'closed' } },
  { name: 'chip-running', path: '/chip', params: { demo: 'chip-run', dock: 'closed' } },
  { name: 'chip-error', path: '/chip', params: { demo: 'chip-failed', dock: 'closed' } },
  { name: 'chip-offline', path: '/chip', params: { demo: 'chip-offline', dock: 'closed' } },
  { name: 'dock-right', path: '/dock', params: { dock: 'right' } },
  { name: 'dock-left', path: '/dock', params: { dock: 'left' } },
  { name: 'dock-offline', path: '/dock', params: { dock: 'right', demo: 'chip-offline' } },
  { name: 'dock-look-off', path: '/dock', params: { dock: 'right', plugins: 'light_ai' } },
  { name: 'hud', path: '/hud', params: { hud: 'three' } },
  { name: 'hud-expanded', path: '/hud', params: { hud: 'three', expand: '1' } },
  { name: 'hud-standalone', path: '/hud', params: { hud: 'standalone' } },
  { name: 'hud-hidden', path: '/hud', params: { hud: 'three', demo: 'hidden' } },
  { name: 'hud-offline', path: '/hud', params: { hud: 'three', expand: '1', offline: '1' } },
];
