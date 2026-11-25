// 新建 requests: a role task is a background job, a coding task an own session.
import { post } from '../../bridge/agentd';
import type { CreateDraft, CreateKind } from './CreateForm';

/** workspace.py ARTIFACT_SUFFIXES: a relative path, no `..`. */
const ARTIFACT = /^(?![/~])(?!.*(?:^|\/)\.\.(?:\/|$)).+\.(md|txt|csv|json)$/i;

const sectionsOf = (s: string) => s.split(/[、,，;；\n]+/).map((x) => x.trim()).filter(Boolean);

/** Why the draft cannot be sent yet; null when it can. */
export function draftProblem(d: CreateDraft, canPick: boolean): string | null {
  if (d.kind === 'code') {
    if (!canPick) return '当前客户端环境不支持原生目录选择';
    if (!d.cwd) return '请先选择工作目录';
    return d.brief.trim() ? null : '请填写任务要求';
  }
  if (!d.title.trim()) return '请填写任务标题';
  if (!d.brief.trim()) return '请填写任务要求';
  const artifact = d.artifact.trim();
  if (artifact && !ARTIFACT.test(artifact)) return '预期产物须为相对路径，支持 .md、.txt、.csv 或 .json';
  if (!artifact && sectionsOf(d.sections).length > 0) return '请先填写预期产物路径';
  return null;
}

/** The refusal of a send whose plug-in agentd does not run. */
export const offText = (kind: CreateKind) => `已在设置中关闭「${kind === 'code' ? '编码会话' : '个人代理与自主能力'}」`;

/** Sends the draft; `select` is the new task row's id (a coding session's own id), `label` names it in the toast. */
export async function submitDraft(d: CreateDraft): Promise<{ select: string; label: string }> {
  if (d.kind === 'code') {
    const prompt = d.brief.trim();
    const { session_id } = await post<{ session_id: string }>('/sessions', { target: d.agent, cwd: d.cwd, prompt, mode: d.mode });
    const line = prompt.split('\n')[0] ?? '';
    return { select: session_id, label: line.length > 24 ? `${line.slice(0, 24)}…` : line };
  }
  const title = d.title.trim();
  const artifact = d.artifact.trim();
  const sections = sectionsOf(d.sections);
  const job = await post<{ job_id: string }>('/agent/jobs', {
    title,
    text: d.brief.trim(),
    scope_id: d.scopeId,
    ...(d.goalId ? { goal_id: d.goalId } : {}),
    ...(artifact ? { expected_outputs: { artifacts: [{ path: artifact, ...(sections.length > 0 ? { checks: { required_sections: sections } } : {}) }] } } : {}),
  });
  return { select: `job:${job.job_id}`, label: title };
}
