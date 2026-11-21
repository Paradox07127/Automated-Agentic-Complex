/** Cause names: character_state.py BECAUSE keys. */
export const CAUSE_LABELS: Record<string, string> = {
  session_done: '会话刚做完',
  dispatch_done: '派的任务做完了',
  dispatch_failed: '派的任务没做成',
  task_verified: '任务通过检查',
  task_failed: '任务出错',
  session_error: '会话出错了',
  user_spoke: '和你聊天',
  feedback_useful: '你说有用',
  blocked: '连着两次走不过去',
};

/** Switch stages, in CharacterSwitch's order; a failure stops at one stage with its reason. */
export const SWITCH_STAGES = ['prepare', 'avatar', 'commit'] as const;

/** Stage names on screen. */
export const SWITCH_STAGE_LABELS: Record<(typeof SWITCH_STAGES)[number], string> = { prepare: '卸载', avatar: '加载资源', commit: '待机就绪' };
