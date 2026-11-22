/** The proactive kinds agentd may mute (proactive.py `MUTABLE`). */
export const MUTED_KIND: Record<string, string> = {
  comment: '久盯一个窗口时搭话',
  back: '回来时汇报',
  break: '休息提示',
  water: '喝水提示',
  stuck: '卡住时问要不要帮忙',
  thought: '冒出的想法',
  session: '会话出事时告诉你',
  task: '任务停了时提醒',
  repeat: '重复的事建议做成定时任务',
};

/** Gate categories: the mutable kinds plus the announcements that pass the gate below P0. */
export const GATE_KIND: Record<string, string> = {
  ...MUTED_KIND,
  dispatch_closed: '派的活过期了，没有开始',
  dispatch_failed: '派的任务没做成',
  dispatch_review: '派的任务回话了，结果要确认',
  session_failed: '会话出错了',
  task_expired: '任务没开始就过期了',
  task_interrupted: '任务被重启打断了',
  focus_done: '专注时段结束',
  reminder_missed: '错过的提醒',
};
