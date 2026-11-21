/** activity.py ACTIVITIES in Chinese; `unknown` cannot be chosen as a correction. */
export const ACTIVITY_LABEL: Readonly<Record<string, string>> = {
  editing_code: '写代码',
  build_failed: '构建失败',
  comparing_sources: '对照资料',
  watching_video: '看视频',
  waiting_approval: '等审批',
  typing: '打字',
  reading: '阅读',
  meeting: '开会',
  gaming: '玩游戏',
  switching: '来回切换',
  away: '离开',
  unreadable: '看不清',
  unknown: '还不确定',
};

/** Chinese name of an activity id; one this list does not know reads 其他活动. */
export const activityLabel = (id: string): string => ACTIVITY_LABEL[id] ?? '其他活动';
