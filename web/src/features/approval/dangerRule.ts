/** danger.py rule codes in words. */
const DANGER_RULE: Readonly<Record<string, string>> = {
  sudo: '以管理员身份运行',
  pipe_to_shell: '把下载的内容直接交给终端执行',
  rm_recursive: '强制递归删除',
  recursive_permissions: '递归修改权限或所有者',
  disk: '直接写入或抹掉磁盘',
  find_delete: '批量查找并删除文件',
  git_force_push: '强制推送 Git 分支',
  git_discard: '丢弃未提交的 Git 改动',
  sensitive_path: '改动系统、密钥或配置文件',
};

/** The rule an approval hit, in words; an unknown code reads as the generic sentence. */
export function dangerRuleText(rule: string): string {
  return DANGER_RULE[rule] ?? '命中危险规则';
}
