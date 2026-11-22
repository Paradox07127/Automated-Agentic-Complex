// A system notification's text and group and the main window route a click on it opens. Which announcements become one is StackSource's.
import { mainRoute } from './stack-cards.ts';
import type { AnnounceKind, SystemNote } from './stack-source.ts';

/** Announcement.kindLabel. */
const KIND_LABELS: Record<AnnounceKind, string> = { done: '完成', waiting: '待确认', error: '出错', brief: '简短', reminder: '提醒' };
/** The thread each kind's notifications group under. */
const SETTING_KEYS: Record<AnnounceKind, string> = {
  done: 'notify_done', waiting: 'notify_approval', error: 'notify_error', brief: 'notify_brief', reminder: 'notify_reminder',
};

/** Electron `Notification` options: `id` is the request identifier, `groupId` the thread identifier. */
export interface NoteContent { id: string; title: string; body: string; groupId: string; silent: boolean }

export function noteContent(note: SystemNote): NoteContent {
  return { id: note.id, title: KIND_LABELS[note.kind], body: note.text, groupId: SETTING_KEYS[note.kind], silent: !note.sound };
}

/** `path` is StackSource.notificationPath's for the note; without it the decision trace, then the session, then the home
 *  page. The bubble's `openAnnouncement` step comes before this, in main/notify/system.ts. */
export function clickRoute(note: SystemNote, path: string | null): string {
  if (path !== null) return path;
  if (note.traceId !== null) return mainRoute('/trace', [['turn', note.traceId]]);
  if (note.sessionId !== null) return mainRoute('/overview', [['sel', note.sessionId], ['focus', `task-${note.sessionId}`]]);
  return '/home';
}
