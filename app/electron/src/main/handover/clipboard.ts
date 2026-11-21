// 把剪贴板交给她: the clipboard's files, links or text go the way of a drop on her, read through the
// platform helper's `clipboard.read`. The log keeps only counts.
import { CLIPBOARD_LIMITS, clipboardDrop } from '../../common/handover.ts';
import type { HelperReply } from '../helper/client.ts';
import type { DropHandover } from './drop.ts';

export interface ClipboardPorts {
  helper: { request(op: string, params?: Record<string, unknown>): Promise<HelperReply> };
  drops: Pick<DropHandover, 'add'>;
  /** Null until the desktop layer is up. */
  desktop(): { notice(text: string): void } | null;
  /** The menus' log. */
  log(line: string): void;
}

export async function handClipboard(o: ClipboardPorts): Promise<void> {
  const notice = (text: string) => {
    const desktop = o.desktop();
    if (desktop) desktop.notice(text);
    else o.log(`clipboard handover: ${text} (desktop layer not ready)`);
  };
  const reply = await o.helper.request('clipboard.read', { max_text_bytes: CLIPBOARD_LIMITS.textBytes });
  if (!reply.ok) return o.log(`clipboard handover failed code=${reply.error.code}`);
  const read = clipboardDrop(reply.result);
  if (read.concealed) return notice('剪贴板里的内容标了保密，没有读');
  if (read.items.length === 0) return notice('剪贴板里没有文字、链接或文件');
  o.log(`clipboard handover items=${read.items.length} truncated=${read.truncated}`);
  o.drops.add(read.items, read.truncated, o.log);
}
