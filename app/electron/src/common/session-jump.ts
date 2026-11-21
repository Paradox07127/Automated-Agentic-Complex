// Feed commands and session jumps: where an external session runs, the
// most precise way to bring it to the front, and which app or session a feed command's target names.

/** Where an external session runs, as agentd saw it in the hook's environment (`SessionOrigin`). */
export interface SessionOrigin {
  /** tmux / terminal / desktop / unknown. */
  kind: string;
  termProgram: string | null;
  tty: string | null;
  tmuxPane: string | null;
  tmuxSocket: string | null;
  pid: number | null;
  entrypoint: string | null;
  bundleId: string | null;
  weztermPane: string | null;
  kittyWindowId: string | null;
  kittyListenOn: string | null;
}

/** The fields of a session the jump and the feed command read. */
export interface SessionInfo {
  sessionId: string;
  own: boolean;
  target: string;
  cwd: string | null;
  updatedAt: number;
  title: string | null;
  origin: SessionOrigin | null;
}

export type JumpPlan =
  | { kind: 'desktop'; cliSessionId: string }
  | { kind: 'tmux'; socket: string; pane: string }
  | { kind: 'wezterm'; pane: string }
  | { kind: 'kitty'; listenOn: string; windowId: string }
  | { kind: 'terminalTTY'; tty: string }
  | { kind: 'iTermTTY'; tty: string }
  | { kind: 'ghostty'; cwd: string }
  | { kind: 'activateBundle'; bundleId: string }
  | { kind: 'activatePid'; pid: number };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function field<T>(o: Record<string, unknown>, key: string, type: 'string' | 'number' | 'boolean', optional: true): T | null;
function field<T>(o: Record<string, unknown>, key: string, type: 'string' | 'number' | 'boolean', optional?: false): T;
function field<T>(o: Record<string, unknown>, key: string, type: 'string' | 'number' | 'boolean', optional = false): T | null {
  const v = o[key];
  if (optional && (v === undefined || v === null)) return null;
  if (typeof v !== type || (type === 'number' && !Number.isFinite(v))) throw new Error(`session ${key} is not a ${type}`);
  return v as T;
}

/** `GET /sessions`' `sessions` decoded: one that does not decode fails them all. */
export function parseSessions(body: unknown): SessionInfo[] {
  if (!isObject(body) || !Array.isArray(body.sessions)) throw new Error('no sessions array');
  return body.sessions.map((s): SessionInfo => {
    if (!isObject(s)) throw new Error('a session is not an object');
    field<string>(s, 'state', 'string');
    let origin: SessionOrigin | null = null;
    if (s.origin !== undefined && s.origin !== null) {
      if (!isObject(s.origin)) throw new Error('session origin is not an object');
      const o = s.origin, str = (key: string) => field<string>(o, key, 'string', true);
      const pid = field<number>(o, 'pid', 'number', true);
      if (pid !== null && !Number.isInteger(pid)) throw new Error('session origin pid is not an integer');
      origin = { kind: field<string>(o, 'kind', 'string'), termProgram: str('term_program'), tty: str('tty'), tmuxPane: str('tmux_pane'),
        tmuxSocket: str('tmux_socket'), pid, entrypoint: str('entrypoint'), bundleId: str('bundle_id'), weztermPane: str('wezterm_pane'),
        kittyWindowId: str('kitty_window_id'), kittyListenOn: str('kitty_listen_on') };
    }
    return { sessionId: field<string>(s, 'session_id', 'string'), own: field<boolean>(s, 'own', 'boolean'), target: field<string>(s, 'target', 'string'),
      cwd: field<string>(s, 'cwd', 'string', true), updatedAt: field<number>(s, 'updated_at', 'number'), title: field<string>(s, 'title', 'string', true),
      origin };
  });
}

const INT32_MAX = 2 ** 31 - 1;

/** The most precise way to bring an external session's window to the front, or null if there is none (`jumpPlan`). */
export function jumpPlan(s: SessionInfo): JumpPlan | null {
  const o = s.origin;
  if (s.own || o === null) return null;
  if (o.entrypoint === 'claude-desktop' || o.kind === 'desktop') {
    const prefix = 'claude:';
    return { kind: 'desktop', cliSessionId: s.sessionId.startsWith(prefix) ? s.sessionId.slice(prefix.length) : s.sessionId };
  }
  if (o.tmuxSocket !== null && o.tmuxPane !== null) return { kind: 'tmux', socket: o.tmuxSocket, pane: o.tmuxPane };
  if (o.weztermPane !== null) return { kind: 'wezterm', pane: o.weztermPane };
  if (o.kittyListenOn !== null && o.kittyWindowId !== null) return { kind: 'kitty', listenOn: o.kittyListenOn, windowId: o.kittyWindowId };
  if (o.termProgram === 'Apple_Terminal' && o.tty !== null) return { kind: 'terminalTTY', tty: o.tty };
  if (o.termProgram === 'iTerm.app' && o.tty !== null) return { kind: 'iTermTTY', tty: o.tty };
  if (o.termProgram === 'ghostty' && s.cwd !== null) return { kind: 'ghostty', cwd: s.cwd };
  if (o.bundleId !== null) return { kind: 'activateBundle', bundleId: o.bundleId };
  if (o.pid !== null && o.pid >= -INT32_MAX - 1 && o.pid <= INT32_MAX) return { kind: 'activatePid', pid: o.pid };
  return null;
}

/** Without a trailing `.app`, without white space, case and width folded (`normalizedName`; NFKC stands for the width folding). */
export function normalizedName(s: string): string {
  const name = s.toLowerCase().endsWith('.app') ? s.slice(0, -4) : s;
  return name.replace(/\s/gu, '').normalize('NFKC').toLowerCase();
}

/** NSString `lastPathComponent`; a Windows path splits at backslashes too. */
function lastComponent(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  return trimmed === '' ? path : trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
}

/** The path of the candidate whose file name or display name matches `target` (`matchApp`). */
export function matchApp(target: string, candidates: { path: string; displayName: string }[]): string | null {
  const t = normalizedName(target);
  if (t === '') return null;
  const names = candidates.map((c) => [normalizedName(lastComponent(c.path)), normalizedName(c.displayName)]);
  const exact = names.findIndex((n) => n.includes(t));
  if (exact !== -1) return candidates[exact]!.path;
  const partial = names.flatMap((n, i) => (n.some((x) => x.includes(t)) ? [i] : []));
  return partial.length === 1 ? candidates[partial[0]!]!.path : null;
}

/** The most recently updated session whose cwd folder, title or target matches `target` (`matchSession`). */
export function matchSession(target: string, sessions: SessionInfo[]): SessionInfo | null {
  const t = normalizedName(target);
  if (t === '') return null;
  let best: SessionInfo | null = null;
  for (const s of sessions) {
    const hit = (s.cwd !== null && normalizedName(lastComponent(s.cwd)) === t) || (s.title !== null && normalizedName(s.title).includes(t))
      || normalizedName(s.target) === t;
    if (hit && (best === null || best.updatedAt < s.updatedAt)) best = s;
  }
  return best;
}

/** Terminal runs `command` the user confirmed. */
export function runInTerminalScript(command: string): string {
  const quoted = command.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `tell application "Terminal"\nactivate\ndo script "${quoted}"\nend tell`;
}

/** The AppleScript error number at the end of osascript's error line (`… (-1743)`), or null. */
export function appleScriptError(line: string): number | null {
  const m = /\((-?\d+)\)\s*$/.exec(line);
  return m ? Number(m[1]) : null;
}
