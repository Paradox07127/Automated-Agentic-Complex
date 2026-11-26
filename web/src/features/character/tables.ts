/** Cause names: character_state.py BECAUSE keys. */
export const CAUSE_LABELS: Record<string, string> = {
  session_done: '对话刚结束',
  dispatch_done: '委派的任务已完成',
  dispatch_failed: '委派的任务未完成',
  task_verified: '任务已通过验证',
  task_failed: '任务执行失败',
  session_error: '对话发生异常',
  user_spoke: '与你对话',
  feedback_useful: '你标记了有用',
  blocked: '连续两次路径受阻',
};

/** Switch stages, in CharacterSwitch's order; a failure stops at one stage with its reason. */
export const SWITCH_STAGES = ['prepare', 'avatar', 'commit'] as const;

/** Stage names on screen. */
export const SWITCH_STAGE_LABELS: Record<(typeof SWITCH_STAGES)[number], string> = { prepare: '卸载', avatar: '加载资源', commit: '就绪' };
