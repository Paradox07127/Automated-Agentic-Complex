import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fromSession, sessionName, unhidden, type RuntimeInfo, type WireSession } from '../../src/domain';
import { actionLine } from '../../src/features/approval/actionLine';
import { kernelNodes } from '../../src/features/kernel/KernelChain';
import { EpisodeDetail } from '../../src/pages/observe/EpisodeDetail';
import { timelineFromDay } from '../../src/pages/overview/today';
import { readPresence } from '../../src/surfaces/desktop/tags/presence';

afterEach(cleanup);

const wire = (over: Partial<WireSession>): WireSession => ({ session_id: 'claude:agent-a4d525', own: false, target: 'claude', cwd: null, title: null, state: 'running', last_line: null, started_at: null, updated_at: 0, ...over });

describe('session names', () => {
  it('sessionName: a Claude Code worktree is its repository 子任务, nothing is 会话', () => {
    expect(sessionName('/Users/me/Endfield/.claude/worktrees/agent-a4d525f1')).toBe('Endfield · 子任务');
    expect(sessionName('/Users/me/Endfield/.claude/worktrees/g2/web/')).toBe('Endfield · 子任务');
    expect(sessionName('/Users/me/Endfield/')).toBe('Endfield');
    expect(sessionName('/Users/me/.claude/worktrees')).toBe('worktrees');
    expect(sessionName(null)).toBe('会话');
    expect(sessionName('')).toBe('会话');
  });

  it('sessionName reads a Windows path by its own separator, drive and UNC roots too', () => {
    expect(sessionName('C:\\w\\repo\\.claude\\worktrees\\ab12')).toBe('repo · 子任务');
    expect(sessionName('C:\\w\\repo')).toBe('repo');
    expect(sessionName('C:\\w\\repo\\')).toBe('repo');
    expect(sessionName('\\\\server\\share\\repo')).toBe('repo');
  });

  it('an approval names the file and the kernel chain the executable by the last segments of a Windows path', () => {
    expect(actionLine({ tool: 'Edit', cmd: 'C:\\w\\repo\\src\\a.ts', title: '', dispatch: null })).toMatchObject({ target: 'a.ts', full: 'C:\\w\\repo\\src\\a.ts' });
    const r = { id: 'codex', path: 'C:\\Users\\me\\AppData\\npm\\codex.cmd', version: '1.0', entry_supported: true, available: true, authenticated: true } as RuntimeInfo;
    expect(kernelNodes(r)[0]?.sub).toBe('npm/codex.cmd');
  });

  it('fromSession: an untitled session in a worktree is named from the repository, not the worktree id', () => {
    expect(fromSession(wire({ cwd: '/Users/me/Endfield/.claude/worktrees/agent-a4d525' })).title).toBe('Endfield · 子任务');
    expect(fromSession(wire({ cwd: '/Users/me/orbit' })).title).toBe('orbit');
    expect(fromSession(wire({ title: '修构建', cwd: '/Users/me/orbit' })).title).toBe('修构建');
  });

  it('readPresence: an untitled session reads 会话, not its id', () => {
    const p = readPresence({ sessions: [{ id: 'claude:agent-a4d525', state: 'running', status: 'running' }, { id: 'codex:b', title: 'orbit' }] });
    expect(p.sessions.map((s) => s.title)).toEqual(['会话', 'orbit']);
  });
});

describe('blacklisted windows', () => {
  it('unhidden reads agentd’s <hidden> placeholder as words', () => {
    expect(unhidden('<hidden>')).toBe('已排除的应用');
    expect(unhidden('在 <hidden> 和 <hidden> 之间切换')).toBe('在 已排除的应用 和 已排除的应用 之间切换');
    expect(unhidden('Terminal')).toBe('Terminal');
  });

  it('today: the timeline never shows <hidden>', () => {
    const entries = timelineFromDay([{ id: '1', t0: 1, t1: 2, app: '<hidden>', title: '<hidden> 里的工作' }], null, [], [], 3);
    expect(entries.map((e) => e.title)).toEqual(['已排除的应用 里的工作']);
  });

  it('EpisodeDetail: the selected segment shows the placeholder as words', () => {
    const episode = { id: '1', start: 0, end: 60_000, title: '<hidden> 里的工作', description: '', apps: ['<hidden>'] } as never;
    render(<EpisodeDetail episode={episode} apps={[{ app: '<hidden>', minutes: null }]} memories={[]} rank={{ order: [] } as never} now={60_000} onMemory={() => {}} onExclude={() => {}} onDelete={() => {}} onEvidence={() => {}} />);
    expect(screen.queryByText(/<hidden>/)).toBeNull();
    expect(screen.getByText('已排除的应用 里的工作')).toBeTruthy();
  });
});
