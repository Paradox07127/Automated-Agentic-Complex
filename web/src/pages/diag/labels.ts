import type { TurnResult } from '../../domain';

export const RESULT_TEXT: Record<TurnResult, string> = { ok: '成功', failed: '失败', interrupted: '打断', skipped: '跳过', running: '进行中', unknown: '回执不全' };
