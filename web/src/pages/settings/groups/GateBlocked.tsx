/** The proactive kinds agentd may mute (proactive.py `MUTABLE`). */
export const MUTED_KIND: Record<string, string> = {
  comment: '长时间注视同一窗口时发起提醒',
  back: '返回电脑时汇报期间摘要',
  break: '休息提醒',
  water: '饮水提醒',
  stuck: '检测到操作受阻时主动询问',
  thought: '关联思考提示',
  session: '会话异常时通知',
  task: '任务中止时通知',
  repeat: '检测到重复操作时建议创建定时任务',
};

/** Gate categories: the mutable kinds plus the announcements that pass the gate below P0. */
export const GATE_KIND: Record<string, string> = {
  ...MUTED_KIND,
  dispatch_closed: '派发任务超时未启动并已过期',
  dispatch_failed: '派发任务执行失败',
  dispatch_review: '派发任务已返回结果，等待复核',
  session_failed: '对话会话异常',
  task_expired: '任务超时未启动',
  task_interrupted: '任务因服务重启而中断',
  focus_done: '专注时段结束',
  reminder_missed: '错过的提醒',
};
