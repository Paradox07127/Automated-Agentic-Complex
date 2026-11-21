// Screenshot-able desktop panel states: open `stack.html#<path>?<params>` (plus `still=1`, `theme=light|dark`).
// The fake bridge reads `demo=` for the anchor, desktop state and presence, and `mode=` for the layer the cmd page opens
// (`mode=input`: 快速输入 in the bubble).
// Pure data so an e2e spec can import the list.

export type DesktopPath = '/cmd' | '/console' | '/bubble' | '/hud' | '/ring';

export interface DesktopDemo {
  name: string;
  path: DesktopPath;
  params: Record<string, string>;
}

export const DESKTOP_DEMOS: DesktopDemo[] = [
  { name: 'cmd-ring', path: '/cmd', params: { mode: 'ring' } },
  { name: 'cmd-tune', path: '/cmd', params: { mode: 'tune', demo: 'passthrough' } },
  { name: 'console-panel', path: '/console', params: {} },
  { name: 'bubble', path: '/bubble', params: {} },
  { name: 'bubble-speech', path: '/bubble', params: { demo: 'speech' } },
  { name: 'bubble-reminder', path: '/bubble', params: { demo: 'reminder' } },
  { name: 'bubble-input', path: '/bubble', params: { mode: 'input' } },
  { name: 'bubble-hidden', path: '/bubble', params: { demo: 'hidden' } },
  { name: 'hud', path: '/hud', params: { hud: 'three' } },
  { name: 'hud-expanded', path: '/hud', params: { hud: 'three', expand: '1' } },
  { name: 'hud-standalone', path: '/hud', params: { hud: 'standalone' } },
  { name: 'hud-hidden', path: '/hud', params: { hud: 'three', demo: 'hidden' } },
  { name: 'ring', path: '/ring', params: { ring: 'icons', hover: '1' } },
  { name: 'ring-reminders', path: '/ring', params: { ring: 'icons', pop: 'reminders' } },
];
