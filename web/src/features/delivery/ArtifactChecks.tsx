import type { Artifact } from '../../domain';

const CHECK: Record<string, string> = {
  artifact_current: '文件内容已变化', nonempty: '文件为空', input_current: '来源已变化或不可用',
  artifact_input_current: '产物所用来源已变化', source_authorized: '来源未授权或未读取',
  source_provenance: '产物缺少要求的来源记录',
  source_reference: '缺少要求的正文引用', required_section: '缺少要求的章节', json_parse: 'JSON 格式错误',
  csv_required: '要求 CSV 文件', csv_shape: 'CSV 行列格式错误', required_column: '缺少要求的列',
  row_count: '数据行数不符', numeric_column: '数值格式错误', calculation: '计算结果不符',
  scope_revoked: '资料授权已撤销', scope_expired: '资料授权已过期', scope_changed: '授权目录已变化',
};

/** Keep attempted self-checks distinct from passing checks, including on a failed delivery. */
export function ArtifactChecks({ artifacts }: { artifacts: readonly Artifact[] }) {
  const failed = artifacts.filter((a) => a.validation?.ok === false);
  if (failed.length === 0) return null;
  return <div role="status" aria-label="产物检查失败">
    <p>产物检查未通过，请补充要求后继续修复。</p>
    <ul>{failed.map((a) => <li key={a.artifact_id}>{a.name}：{a.validation?.checks.filter((c) => !c.ok).map((c) =>
      `${CHECK[c.check] ?? '检查未通过'}${c.column ? `（${c.column}）` : c.section ? `（${c.section}）` : ''}`).join('；')}</li>)}</ul>
  </div>;
}
