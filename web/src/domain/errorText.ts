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
  native_login_required: '当前执行内核尚未登录，请在终端运行 codex login 或 claude auth login，完成后在「设置 › 内核」重新检测',
  bundled_cli_missing: '内置执行内核文件不完整，请重新安装应用',
  bundled_runtime_missing: '应用未内置该执行内核，请在「设置 › 内核」切换运行来源',
  runtime_protocol_unavailable: '执行内核入口不可用，请更新工具后在「设置 › 内核」重新检测',
  api_error: '执行内核调用失败，请在「设置 › 内核」重新检测',
  pi_connection_missing: '尚未配置模型连接，请前往「设置 › 内核」填写 API Key',
  product_login_required: '执行内核尚未在应用内登录，请前往「设置 › 内核」登录后重试',
  acp_auth_required: 'ACP 智能体尚未登录，请登录后在「设置 › 内核」重新检测',
  missing_provider_api_key: '尚未填写模型服务的 API Key，请前往「设置 › 内核」填写',
  local_node_missing: '未找到本地 Node.js，请安装后在「设置 › 内核」重新检测',
  pi_provider_model_required: '尚未选择模型，请前往「设置 › 内核」选择服务提供方和模型',
  character_context_unavailable: '角色资料尚未就绪，请稍后重试',
  acp_agent_missing: '尚未选择 ACP 智能体，请前往「设置 › 内核」选择',
  local_runtime_missing: '未找到可用的 Claude Code、Codex 或 ACP 智能体，安装并登录后请在「设置 › 内核」重新检测',
  runtime_version_not_verified: '执行内核版本未通过兼容检查，请更新后在「设置 › 内核」重新检测',
  no_llm: '执行内核尚未就绪',
  no_character: '当前角色库为空，请前往「角色」页导入角色',
  output_truncated: '回复长度超出模型输出上限已被截断，请分段生成或更换输出上限更高的模型',
  // Goals, jobs, task ledger and conversations
  version_conflict: '该记录已更新，请刷新后重试',
  job_not_resumable: '该任务当前状态不支持继续，请刷新状态后重试',
  goal_not_active: '关联目标已暂停或结束，请先恢复目标',
  busy: '角色正在执行中，请先停止当前轮次',
  character_busy: '角色正在执行中，请先停止当前轮次',
  task_still_running: '角色正在执行中，请先停止当前轮次',
  archived: '请先从归档中恢复该对话',
  conversation_not_active: '请先选择「继续此对话」后再发送消息',
  no_history: '尚未开启对话记录，无法读取或管理历史',
  invalid_goal: '目标标题或描述为空或超出长度限制，请修改后重试',
  invalid_job: '任务标题为空或超出长度限制，请修改后重试',
  background_queue_full: '后台任务队列已满，请等待部分任务结束后再试',
  unknown_goal: '该记录已不存在，请刷新后查看',
  unknown_job: '该记录已不存在，请刷新后查看',
  unknown_task: '该记录已不存在，请刷新后查看',
  unknown_run: '该运行记录已不存在，请刷新后查看',
  unknown_character_task: '该记录已不存在，请刷新后查看',
  invalid_verify_cmd: '校验命令未通过安全检查，请改用只读或安全命令',
  invalid_state: '任务当前状态不支持此操作',
  no_tasks: '后台服务未启用任务记录',
  invalid_query: '查询参数无效，未被后台服务接受',
  invalid_cursor: '列表分页位置已失效，请刷新',
  // agentd service state (character_agent/routes/http.py)
  unauthorized: '后台服务拒绝访问',
  resetting: '后台服务正在重置，请稍后重试',
  shutting_down: '后台服务正在退出',
  character_runtime_unavailable: '执行内核尚未启动',
  delivery_store_unavailable: '任务交付记录暂不可用',
  // Interactions
  interaction_expired: '该请求已过期，请重新发起',
  approval_expired: '该请求已过期，请重新发起',
  invalid_answers: '回答格式无效，请重新填写',
  // The bridge (status 0)
  offline: '后台服务已断开',
  declined: '请求未获应用批准',
  unclassified_route: '请求未获应用批准',
  route_class: '请求未获应用批准',
  surface_not_allowed: '请求未获应用批准',
  invalid_method: '请求未获应用批准',
  invalid_path: '请求未获应用批准',
  invalid_body: '请求未获应用批准',
  handle_required: '请求未获应用批准',
  not_implemented: '当前平台暂不支持此操作',
  // 409 from /say, /feedback and the tap while a character switch runs: nothing changed, unlike a conflict.
  switching: '正在切换角色，请稍后再试',
  // /say's commands and dispatch (daemon/turns.py)
  no_cwd: '未指定工作目录，无法派发任务',
  no_memory_dispatch: '当前处于无痕对话模式，无法派发任务：对话内容会保留在外部内核记录中',
  no_reminder_time: '未识别到提醒时间或内容',
  no_commitments: '当前暂不支持创建提醒',
  invalid_text: '内容为空或超出长度上限，请修改后重试',
  no_pending_approval: '当前没有待批准的请求，无需拒绝',
  ambiguous_approval: '存在多项待批准请求，无法判断要拒绝哪一项',
  no_task: '当前没有运行中的任务，无需停止',
  ambiguous_task: '存在多个运行中的任务，请前往「每日简报」或「任务」页面停止',
  op_not_allowed: '当前平台暂不支持此操作',
};

/** The sentence for a known code; null for any other. */
export function codeText(code: string | null | undefined): string | null {
  return (code && CODE_TEXT[code]) || null;
}

const CJK = /[一-鿿]/;

/** A sentence by status alone, for a code nobody mapped. */
function statusText(status: number): string {
  if (status === 0) return '应用未能完成该请求';
  if (status === 401 || status === 403) return '后台服务拒绝访问';
  if (status === 404) return '未找到对应记录';
  if (status === 409) return '状态已在其他位置更新';
  if (status === 503) return '该功能模块暂不可用';
  if (status >= 400 && status < 500) return '请求参数无效或不被接受';
  return '后台服务处理出错';
}

/**
 * agentd is up but its handler failed (`internal_error`, or a 5xx other than 503 with no code): 「后台出错：<接口>」, never「后台已断开」.
 * null for anything else, so a 5xx with its own code keeps that code's sentence.
 */
export function serverFaultText(f: { status: number; code?: string | null; body?: unknown }): string | null {
  if (f.code !== 'internal_error' && !(f.status >= 500 && f.status !== 503 && f.code === `http_${f.status}`)) return null;
  const route = (f.body as { route?: unknown } | null | undefined)?.route;
  return typeof route === 'string' ? `后台服务处理出错：${route}` : `后台服务处理出错（${f.status}）`;
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
