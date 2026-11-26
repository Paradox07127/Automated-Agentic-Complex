import { describe, expect, it } from 'vitest';
import { fromInteraction, type StackCard } from '../../src/domain';
import { approvalView, isApprovalCard, outcomeOfReceipt } from '../../src/features/approval';
import { NOW, WIRE_INTERACTION_APPROVAL, WIRE_INTERACTION_APPROVAL_AGENTD, WIRE_INTERACTION_APPROVAL_DANGER, WIRE_INTERACTIONS } from '../../src/mock/fixtures';
import { A1, A2 } from '../../src/mock/fixtures/ids';
import { stackScenario } from '../../src/mock/stack';

// One view-model over broker approvals and role exact-call approvals.

const brokerCards = stackScenario('default').cards.filter((c): c is Extract<StackCard, { kind: 'approval' }> => c.kind === 'approval');
const broker = (id: string) => brokerCards.find((c) => c.id === id)!;
const role = (w: typeof WIRE_INTERACTION_APPROVAL, extra: Partial<Extract<StackCard, { kind: 'question' }>> = {}): Extract<StackCard, { kind: 'question' }> => ({
  id: w.request_id,
  kind: 'question',
  at: NOW,
  item: fromInteraction(w, NOW),
  ...extra,
});
const roleView = (card: StackCard) => {
  if (!isApprovalCard(card)) throw new Error(`${card.id} is not an approval`);
  return approvalView(card);
};

describe('approvalView', () => {
  it('isApprovalCard takes broker and role approvals, not plain questions', () => {
    expect(isApprovalCard(broker(A2))).toBe(true);
    expect(isApprovalCard(role(WIRE_INTERACTION_APPROVAL))).toBe(true);
    expect(isApprovalCard(role(WIRE_INTERACTIONS[0]!))).toBe(false);
  });

  it('a broker card keeps its own fields; allow_session only when scope_ok and not dangerous', () => {
    expect(brokerCards.length).toBeGreaterThan(1);
    for (const card of brokerCards) {
      const { item } = card;
      const v = approvalView(card);
      expect(v).toMatchObject({
        id: item.id,
        source: 'broker',
        tool: item.tool,
        origin: item.source,
        title: item.title,
        cmd: item.cmd ?? null,
        truncated: item.summary_truncated === true,
        origLen: item.orig_len ?? null,
        diff: item.content_preview ?? null,
        cwd: item.cwd,
        previewText: null,
        dangerous: item.dangerous,
        dangerRule: item.danger_rule ?? null,
        allowSession: item.scope_ok === true && !item.dangerous,
        sessionScope: item.session_scope,
        dispatch: item.dispatch,
        windowS: item.window_s,
        secondsLeft: item.seconds_left,
        since: item.since,
        outcome: null,
        links: true,
        extra: [],
        token: item.generation,
      });
      // An own session's call is declined back to it; only a hook card's call waits in the terminal.
      if (item.display_session?.startsWith('own:')) expect(v.expiredNote).toBe('这次调用没有执行，会话按「拒绝」继续');
      else expect(v.expiredNote).toContain('这次工具调用按「未批准」处理');
    }
    expect(approvalView(broker(A2)).allowSession).toBe(true);
    expect(approvalView(broker(A1))).toMatchObject({ dangerous: true, dangerRule: 'rm_recursive', allowSession: false });
    const outcome = { kind: 'approved' as const, at: NOW };
    expect(approvalView({ ...broker(A2), outcome }).outcome).toEqual(outcome);
  });

  it('a role approval reads source, danger, a 180 s window and its preview', () => {
    const plain = roleView(role(WIRE_INTERACTION_APPROVAL));
    expect(plain).toMatchObject({
      id: WIRE_INTERACTION_APPROVAL.request_id,
      source: 'exact_call',
      tool: '',
      origin: '角色 │ 请求批准',
      title: WIRE_INTERACTION_APPROVAL.data!.questions[0]!.question,
      cmd: null,
      diff: null,
      cwd: null,
      previewText: WIRE_INTERACTION_APPROVAL.data!.preview_text,
      dangerous: false,
      dangerRule: null,
      allowSession: false,
      sessionScope: null,
      dispatch: null,
      windowS: 180,
      expiredNote: '这次调用没有执行',
      links: false,
      token: WIRE_INTERACTION_APPROVAL.revision,
    });
    expect(plain.secondsLeft).toBe(Math.max(0, WIRE_INTERACTION_APPROVAL.expires_at - NOW / 1000));
    expect(plain.extra.map((e) => e.label)).toEqual(['稍后', '取消这个请求']);
    const danger = roleView(role(WIRE_INTERACTION_APPROVAL_DANGER));
    expect(danger).toMatchObject({ source: 'exact_call', dangerous: true, dangerRule: 'rm_recursive', windowS: 180, allowSession: false });
    expect(danger.previewText).toContain('rm -rf ~/x');
  });

  it('an ACP agent approval reads as the agent, its title, the call and the paths, not the raw preview', () => {
    const preview = { source: 'acp_agent', agent: 'Claude Agent', title: '编辑 a.ts', kind: 'edit', locations: ['/repo/src/a.ts', '/repo/src/b.ts'], raw_input: { file_path: '/repo/src/a.ts' } };
    const w = { ...WIRE_INTERACTION_APPROVAL, data: { ...WIRE_INTERACTION_APPROVAL.data!, preview, preview_text: JSON.stringify(preview, null, 2) } };
    const call = `类型：编辑\n${JSON.stringify(preview.raw_input, null, 2)}`;
    expect(roleView(role(w))).toMatchObject({ origin: 'Claude Agent │ 请求批准', title: '编辑 a.ts', previewText: `${call}\n/repo/src/a.ts\n/repo/src/b.ts` });
    const bare = { ...preview, locations: null };
    const v = roleView(role({ ...w, data: { ...w.data, preview: bare, preview_text: JSON.stringify(bare, null, 2) } }));
    expect(v).toMatchObject({ origin: 'Claude Agent │ 请求批准', title: '编辑 a.ts', previewText: call });
    const empty = { ...bare, kind: null, raw_input: {} };
    expect(roleView(role({ ...w, data: { ...w.data, preview: empty, preview_text: JSON.stringify(empty, null, 2) } })).previewText).toBeNull();
  });

  it("a Pi approval reads as Pi, the tool and its target, and the file it writes", () => {
    const preview = { source: 'pi', agent: 'Pi', title: 'write: plan.md', kind: 'edit', locations: ['/Users/demo/AgenticComplex/plan.md'], raw_input: { path: 'plan.md', content: 'draft' } };
    const w = { ...WIRE_INTERACTION_APPROVAL, data: { ...WIRE_INTERACTION_APPROVAL.data!, preview, preview_text: JSON.stringify(preview, null, 2) } };
    expect(roleView(role(w))).toMatchObject({ origin: 'Pi │ 请求批准', title: 'write: plan.md', previewText: `类型：编辑\n${JSON.stringify(preview.raw_input, null, 2)}\n/Users/demo/AgenticComplex/plan.md` });
  });

  it('a Claude Code or Codex approval reads as that kernel', () => {
    for (const [source, agent] of [['claude', 'Claude Code'], ['codex', 'Codex']]) {
      const preview = { source, agent, title: 'Bash', kind: null, locations: null, raw_input: { command: 'ls' } };
      const w = { ...WIRE_INTERACTION_APPROVAL, data: { ...WIRE_INTERACTION_APPROVAL.data!, preview, preview_text: JSON.stringify(preview, null, 2) } };
      expect(roleView(role(w))).toMatchObject({ origin: `${agent} │ 请求批准`, title: 'Bash', previewText: 'ls' });
    }
  });

  it('a harness approval shows the call it authorizes: its kind and the command or the arguments', () => {
    const preview = { source: 'codex', agent: 'Codex', title: 'Bash', kind: 'execute', locations: null, raw_input: { command: 'rm -rf build' } };
    const w = { ...WIRE_INTERACTION_APPROVAL, data: { ...WIRE_INTERACTION_APPROVAL.data!, preview, preview_text: JSON.stringify(preview, null, 2) } };
    const v = roleView(role(w));
    expect(v.title).toBe('Bash');
    expect(v.previewText).toContain('rm -rf build');
    expect(v.previewText).toContain('执行');
    const write = { ...preview, title: 'Write', kind: 'edit', raw_input: { file_path: '/repo/a.ts', content: 'export const a = 1;' } };
    const ww = { ...w, data: { ...w.data, preview: write, preview_text: JSON.stringify(write, null, 2) } };
    expect(roleView(role(ww)).previewText).toContain('export const a = 1;');
  });

  it("agentd's own single-use approval reads its title and one 键：值 line per argument, not the raw preview", () => {
    const v = roleView(role(WIRE_INTERACTION_APPROVAL_AGENTD));
    expect(v).toMatchObject({ origin: '角色 │ 请求批准', title: '取消提醒「喝水」' });
    expect(v.previewText).toBe('reminder_id：rem-3f2a\nexpected_revision：2\nwhen：{"at":"15:00","repeat":"daily"}');
    const bare = { source: 'agentd', title: '删除记忆', kind: 'other', raw_input: {} };
    const w = { ...WIRE_INTERACTION_APPROVAL_AGENTD, data: { ...WIRE_INTERACTION_APPROVAL_AGENTD.data!, preview: bare, preview_text: JSON.stringify(bare, null, 2) } };
    expect(roleView(role(w))).toMatchObject({ title: '删除记忆', previewText: null });
  });

  it('action builds the CardAction each source already sends', () => {
    const b = approvalView(broker(A2));
    expect(b.action('allow')).toEqual({ type: 'decide', id: A2, decision: 'allow', generation: 7 });
    expect(b.action('allow_session')).toEqual({ type: 'decide', id: A2, decision: 'allow_session', generation: 7 });
    expect(b.action('deny')).toEqual({ type: 'decide', id: A2, decision: 'deny', generation: 7 });
    expect(b.action('allow', 'plan')).toEqual({ type: 'decide', id: A2, decision: 'allow', generation: 7, mode: 'plan' });
    expect(b.action('cancel')).toBeNull();

    const id = WIRE_INTERACTION_APPROVAL.request_id;
    const r = roleView(role(WIRE_INTERACTION_APPROVAL));
    expect(r.action('allow')).toEqual({ type: 'answer', id, expected_version: 1, answers: { decision: ['允许'] }, text: '允许' });
    expect(r.action('deny')).toEqual({ type: 'answer', id, expected_version: 1, answers: { decision: ['拒绝'] }, text: '拒绝' });
    expect(r.action('cancel')).toEqual({ type: 'cancel-question', id, expected_version: 1 });
    expect(r.action('allow_session')).toBeNull();
    expect(r.extra.map((e) => e.action)).toEqual([
      { type: 'collapse', id },
      { type: 'cancel-question', id, expected_version: 1 },
    ]);
  });

  it('outcomeOfReceipt maps the role receipts', () => {
    const at = NOW;
    expect(outcomeOfReceipt('已允许', at)).toEqual({ kind: 'approved', at });
    expect(outcomeOfReceipt('已回答：允许', at)).toEqual({ kind: 'approved', at });
    expect(outcomeOfReceipt('已拒绝', at)).toEqual({ kind: 'denied', at, text: '已拒绝' });
    expect(outcomeOfReceipt('已回答：拒绝', at)).toEqual({ kind: 'denied', at, text: '已回答：拒绝' });
    expect(outcomeOfReceipt('已取消这个请求', at)).toEqual({ kind: 'denied', at, text: '已取消这个请求' });
    expect(outcomeOfReceipt('已取消这次提问', at)).toEqual({ kind: 'denied', at, text: '已取消这次提问' });
    expect(outcomeOfReceipt('已过期', at)).toEqual({ kind: 'expired', at });
    expect(outcomeOfReceipt('已在别处处理', at)).toEqual({ kind: 'elsewhere', at, text: '已在别处处理' });
    expect(outcomeOfReceipt('已回答：包含', at)).toBeNull();
    expect(outcomeOfReceipt(undefined, at)).toBeNull();
  });

  it('a role card falls back to its receipt for the outcome; its own outcome wins', () => {
    expect(roleView(role(WIRE_INTERACTION_APPROVAL, { receipt: '已拒绝' })).outcome).toEqual({ kind: 'denied', at: NOW, text: '已拒绝' });
    const outcome = { kind: 'approved' as const, at: NOW + 1 };
    expect(roleView(role(WIRE_INTERACTION_APPROVAL, { receipt: '已拒绝', outcome })).outcome).toEqual(outcome);
  });
});
