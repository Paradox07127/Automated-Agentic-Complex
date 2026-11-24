// Readable names for sessions and windows that agentd reports by path or placeholder.

/** A path's segments for display, split on both `/` and `\`: `C:\w\repo` gives C:, w, repo; a UNC path drops its leading `\\`. */
export const pathParts = (path: string): string[] => path.split(/[\\/]+/).filter(Boolean);

/** A session's name from its cwd; Claude Code names its `<repo>/.claude/worktrees/<name>` worktrees with a random id. */
export function sessionName(cwd?: string | null): string {
  const parts = pathParts(cwd ?? '');
  for (let i = 1; i < parts.length - 2; i++) if (parts[i] === '.claude' && parts[i + 1] === 'worktrees') return `${parts[i - 1]} · 子任务`;
  return parts[parts.length - 1] ?? '会话';
}

/** Text with agentd's placeholder for a blacklisted window (blacklist.py `HIDDEN`) in words. */
export const unhidden = (text: string) => text.split('<hidden>').join('已排除的应用');
