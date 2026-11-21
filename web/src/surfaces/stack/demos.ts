// Screenshot-able card and session states of the desktop panels: open `stack.html#/hud?demo=<name>` (or `#/ring`, plus
// `still=1`, `theme=light|dark`). Pure data so an e2e spec can import the list.

export interface StackUiPreset {
  /** Mock scenario from `stackScenario()` that the fake bridge pushes to the page. */
  scenario: string;
  /** Presence session rows from `stackSessions()` instead of the shared fixtures. */
  sessions?: 'one' | 'between' | 'three' | 'approval' | 'question' | 'danger';
}

export const STACK_PRESETS: Record<string, StackUiPreset> = {
  default: { scenario: 'default' },
  proto: { scenario: 'proto' },
  question: { scenario: 'question' },
  'role-approval': { scenario: 'role-approval' },
  review: { scenario: 'review' },
  'coding-review': { scenario: 'coding-review' },
  delivery: { scenario: 'delivery' },
  notices: { scenario: 'notices' },
  'task-error': { scenario: 'task-error' },
  timeout: { scenario: 'timeout' },
  history: { scenario: 'history' },
  collapsed: { scenario: 'collapsed' },
  empty: { scenario: 'empty' },
  'session-one': { scenario: 'empty', sessions: 'one' },
  'session-between': { scenario: 'empty', sessions: 'between' },
  sessions: { scenario: 'empty', sessions: 'three' },
  'session-approval': { scenario: 'session-approval', sessions: 'approval' },
  'session-question': { scenario: 'session-question', sessions: 'question' },
  'session-danger': { scenario: 'session-danger', sessions: 'danger' },
  offline: { scenario: 'offline' },
};

const DEFAULT_PRESET: StackUiPreset = { scenario: 'default' };

/** Preset for a demo name; unknown names fall back to the default stack. */
export function presetFor(name: string | null): StackUiPreset {
  return (name && STACK_PRESETS[name]) || DEFAULT_PRESET;
}

/** One entry per state, for screenshots: name plus the hash query that opens it. */
export const STACK_DEMOS: Array<{ name: string; params: Record<string, string> }> = Object.keys(STACK_PRESETS).map((name): { name: string; params: Record<string, string> } => ({
  name,
  params: name === 'default' ? {} : { demo: name },
}));

/** Query after `#…?` (or the search string) of the current URL. */
export function stackQuery(): URLSearchParams {
  const hash = window.location.hash;
  const i = hash.indexOf('?');
  return new URLSearchParams(i < 0 ? window.location.search : hash.slice(i + 1));
}
