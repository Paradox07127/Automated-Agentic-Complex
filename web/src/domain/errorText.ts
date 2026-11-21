// agentd and bridge error codes as one Chinese sentence for the user; pages never show the raw code.

/** Sentences for the codes agentd and the bridge send. */
const CODE_TEXT: Readonly<Record<string, string>> = {
  // classify_failure() in character_agent/harness/runner.py
  auth_expired: '登录已过期，请重新登录',
  quota_exhausted: '可用额度已用完，请检查账户额度',
  rate_limited: '请求过于频繁，请稍后重试',
  network: '连接服务失败，请稍后重试',
  timeout: '请求超时，请重试',
  refusal: '模型拒绝了这次请求，请调整请求内容',
  tool_failed: '工具执行失败，请检查操作后重试',
  usage_cap: '已达到用量上限，请稍后再试或调整用量设置',
  // Kernel readiness (integration.py public()) and an unclassified harness failure
  native_login_required: '还没有登录这个内核',
  bundled_cli_missing: '应用自带的内核文件不全，请重新安装应用',
  bundled_runtime_missing: '应用里没有带这个内核，请在 设置 › 角色内核 改运行来源',
  runtime_protocol_unavailable: '角色入口不可用，请更新内核后在 设置 › 角色内核 重新检测',
  api_error: '内核调用失败，请在 设置 › 角色内核 重新检测',
  pi_connection_missing: '还没有模型连接。到 设置 › pi 账号与凭据 填一个 API Key',
  no_character: '角色库里没有角色。到「角色」页点「导入角色」',
  output_truncated: '回复太长，被模型的输出上限截断了。让她分几段写，或换一个输出上限更大的模型',
  // Goals, jobs, task ledger and conversations
  version_conflict: '这条记录已更新，请刷新后重试',
  job_not_resumable: '这项任务当前不能继续，请刷新任务状态',
  goal_not_active: '关联目标已暂停或结束，请先恢复目标',
  busy: '角色正在执行，请先中断当前轮次',
  character_busy: '角色正在执行，请先中断当前轮次',
  task_still_running: '角色正在执行，请先中断当前轮次',
  archived: '请先从归档中恢复这条对话',
  conversation_not_active: '请先选择「继续此对话」，再发送消息',
  no_history: '尚未开启对话记录，无法读取或管理历史',
  invalid_goal: '目标标题或描述为空或过长，请修改后重试',
  invalid_job: '任务标题为空或过长，请修改后重试',
  background_queue_full: '后台任务已排满，请等部分任务结束后再开始',
  unknown_goal: '这条记录已不存在，请刷新后查看',
  unknown_job: '这条记录已不存在，请刷新后查看',
  unknown_task: '这条记录已不存在，请刷新后查看',
  unknown_run: '这次运行已不存在，请刷新后查看',
  unknown_character_task: '这条记录已不存在，请刷新后查看',
  invalid_verify_cmd: '检查命令不被允许，请换用只读或安全的命令',
  invalid_state: '任务现在的状态不允许这样操作',
  no_tasks: '后台没有开启任务记录',
  invalid_query: '后台不接受这次查询',
  invalid_cursor: '翻页位置已失效，请刷新',
  // agentd service state (character_agent/routes/http.py)
  unauthorized: '后台拒绝访问',
  resetting: '后台正在重置，请稍后重试',
  shutting_down: '后台正在退出',
  character_runtime_unavailable: '角色内核没有启动',
  delivery_store_unavailable: '任务交付记录暂不可用',
  // Interactions
  interaction_expired: '这个请求已过期，请让角色重新发起',
  approval_expired: '这个请求已过期，请让角色重新发起',
  invalid_answers: '回答格式不正确，请重新填写',
  // The bridge (status 0)
  offline: '后台已断开',
  declined: '桌面端拒绝了这个请求',
  unclassified_route: '桌面端拒绝了这个请求',
  route_class: '桌面端拒绝了这个请求',
  surface_not_allowed: '桌面端拒绝了这个请求',
  invalid_method: '桌面端拒绝了这个请求',
  invalid_path: '桌面端拒绝了这个请求',
  invalid_body: '桌面端拒绝了这个请求',
  handle_required: '桌面端拒绝了这个请求',
  not_implemented: '这台电脑的外壳暂不支持这个操作',
  // 409 from /say, /feedback and the tap while a character switch runs: nothing changed, unlike a conflict.
  switching: '正在换角色，稍后再试',
  op_not_allowed: '这台电脑的外壳暂不支持这个操作',
};

/** The sentence for a known code; null for any other. */
export function codeText(code: string | null | undefined): string | null {
  return (code && CODE_TEXT[code]) || null;
}

const CJK = /[一-鿿]/;

/** A sentence by status alone, for a code nobody mapped. */
function statusText(status: number): string {
  if (status === 0) return '桌面端没有完成这个请求';
  if (status === 401 || status === 403) return '后台拒绝访问';
  if (status === 404) return '后台没有这一项';
  if (status === 409) return '已在别处更新';
  if (status === 503) return '后台这部分暂不可用';
  if (status >= 400 && status < 500) return '后台不接受这个请求';
  return '后台出错了';
}

/**
 * agentd is up but its handler failed (`internal_error`, or a 5xx other than 503 with no code): 「后台出错：<接口>」, never「后台已断开」.
 * null for anything else, so a 5xx with its own code keeps that code's sentence.
 */
export function serverFaultText(f: { status: number; code?: string | null; body?: unknown }): string | null {
  if (f.code !== 'internal_error' && !(f.status >= 500 && f.status !== 503 && f.code === `http_${f.status}`)) return null;
  const route = (f.body as { route?: unknown } | null | undefined)?.route;
  return typeof route === 'string' ? `后台出错：${route}` : `后台出错（${f.status}）`;
}

/**
 * A failed read or write as one sentence: the code's sentence, agentd's own detail when it is Chinese, else a sentence by status.
 * `code` is set only when the sentence is generic, so the page can keep it in a tooltip or a copy action.
 */
export function failureText(f: { status: number; code?: string | null; detail?: string | null; body?: unknown }): { text: string; code: string | null } {
  const fault = serverFaultText(f);
  if (fault) return { text: fault, code: null };
  const known = codeText(f.code);
  if (known) return { text: known, code: null };
  if (f.detail && CJK.test(f.detail)) return { text: f.detail, code: null };
  return { text: statusText(f.status), code: f.code ?? null };
}

/** What a coding task's verify result says (tasks.py verify, own.py and server.py stop_task). */
const VERIFY_REASON: Readonly<Record<string, string>> = {
  no_verify_cmd: '没有设置检查命令',
  timeout: '检查命令超时',
  not_started: '检查命令没能运行，请检查命令和目录',
  interrupted: '这一轮被中断',
  restart: '后台重启时中断',
  stop_task: '已被停止',
};

/** One line for a coding task's verify result; the exit code decides when there is no reason. */
export function verifyText(v: { exit_code: number | null; reason: string | null }): string {
  if (v.reason) return VERIFY_REASON[v.reason] ?? '检查没有完成';
  if (v.exit_code === 0) return '检查通过';
  return v.exit_code == null ? '检查没有完成' : '检查没通过';
}
