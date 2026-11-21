// StackSource's `notifier` over Electron's `Notification`, and what a click on one opens.
import { clickRoute, type NoteContent, noteContent } from '../../common/notify.ts';
import { mainRoute } from '../../common/stack-cards.ts';
import type { SystemNote } from '../../common/stack-source.ts';

export type { NoteContent };

/** The part of an Electron `Notification` this uses. */
export interface ShownNote {
  on(event: 'show' | 'click', listener: () => void): unknown;
  on(event: 'failed', listener: (event: unknown, error: string) => void): unknown;
  show(): void;
  close(): void;
}

export interface NotifierPorts {
  /** `Notification.isSupported()`. */
  supported(): boolean;
  /** `new Notification(content)`. */
  create(content: NoteContent): ShownNote;
  /** StackSource.notificationPath, read at the click. */
  notificationPath(id: string): string | null;
  /** Opens the main window at a hash route and brings it to the front. */
  openMain(route: string): void;
  /** 最近播报, read first at the click; absent without it. */
  recent?: { open(id: string): string | null };
}

export class SystemNotifier {
  private readonly ports: NotifierPorts;
  /** Posted and not withdrawn, clicked or refused; Electron takes a notification away once its object is collected. */
  private readonly held = new Map<string, ShownNote>();

  constructor(ports: NotifierPorts) {
    this.ports = ports;
  }

  /** True once the system showed it; false when it has no notifications or refused this one (the user turned them off),
   *  as `live` answers a refused authorization. */
  post(note: SystemNote): Promise<boolean> {
    if (!this.ports.supported()) return Promise.resolve(false);
    const shown = this.ports.create(noteContent(note));
    this.held.set(note.id, shown);
    shown.on('click', () => {
      this.held.delete(note.id);
      const session = this.ports.recent?.open(note.id) ?? null;
      this.ports.openMain(session === null ? clickRoute(note, this.ports.notificationPath(note.id))
        : mainRoute('/overview', [['sel', session], ['focus', `task-${session}`]]));
    });
    return new Promise((resolve) => {
      shown.on('show', () => resolve(true));
      shown.on('failed', () => {
        this.held.delete(note.id);
        resolve(false);
      });
      shown.show();
    });
  }

  /** Takes back the notifications of settled announcements. */
  withdraw(ids: string[]): void {
    for (const id of ids) {
      this.held.get(id)?.close();
      this.held.delete(id);
    }
  }
}
