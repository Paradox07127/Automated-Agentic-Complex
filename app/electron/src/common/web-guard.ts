// What a page may navigate to and which edit menu it gets, and the lines of its `ui.log`.

/** Whether `url` is on the pages' own scheme and host. */
export function navigationAllowed(url: string, origin: string): boolean {
  if (!URL.canParse(url)) return false;
  const u = new URL(url), o = new URL(origin);
  return u.protocol === o.protocol && u.host === o.host;
}

/** Only these go to the system browser. */
export function externalUrl(url: string): boolean {
  return /^https?:/i.test(url);
}

export type EditRole = 'cut' | 'copy' | 'paste';
export interface EditItem { role: EditRole; label: string; enabled: boolean }

/** The menu in a text field, or over selected text (`[data-selectable]`); none elsewhere. */
export function editMenu(p: { isEditable: boolean; selectionText: string; editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean } }): EditItem[] {
  const copy: EditItem = { role: 'copy', label: '复制', enabled: p.editFlags.canCopy };
  if (p.isEditable) return [{ role: 'cut', label: '剪切', enabled: p.editFlags.canCut }, copy, { role: 'paste', label: '粘贴', enabled: p.editFlags.canPaste }];
  return p.selectionText === '' ? [] : [copy];
}

/** `ui.log`'s limits. */
export const WEB_LOG = { maxMessageBytes: 4096, perMinute: 60, maxFileBytes: 1 << 20 } as const;

/** `text` cut to `maxMessageBytes` of UTF-8 on a character boundary, ending in `…` when cut. */
export function clipMessage(text: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= WEB_LOG.maxMessageBytes) return text;
  const budget = WEB_LOG.maxMessageBytes - encoder.encode('…').length;
  let out = '', used = 0;
  for (const ch of text) {
    used += encoder.encode(ch).length;
    if (used > budget) break;
    out += ch;
  }
  return `${out}…`;
}

/** One page's error lines: `ISO time<TAB>surface<TAB>#fragment<TAB>message<TAB>stack`, line breaks written as `\n`. */
export class WebErrorLog {
  private readonly surface: string;
  private readonly write: (line: string) => void;
  private windowStart: number | null = null;
  private accepted = 0;
  private dropped = 0;

  constructor(surface: string, write: (line: string) => void) {
    this.surface = surface;
    this.write = write;
  }

  /** `text` is `message\nstack`; `at` in epoch ms. At most `perMinute` a minute are written; the count of the ones over it is
   *  written once when the next minute's first arrives. */
  record(text: string, fragment: string, at: number): void {
    if (this.windowStart !== null && at - this.windowStart < 60_000) {
      if (this.accepted >= WEB_LOG.perMinute) {
        this.dropped += 1;
        return;
      }
    } else {
      if (this.dropped > 0) this.line(at, fragment, `dropped ${this.dropped} web errors over ${WEB_LOG.perMinute} a minute`, '');
      this.windowStart = at;
      this.accepted = 0;
      this.dropped = 0;
    }
    this.accepted += 1;
    const clipped = clipMessage(text), cut = clipped.indexOf('\n');
    const first = cut < 0 ? clipped : clipped.slice(0, cut);
    this.line(at, fragment, first, cut < 0 ? '' : clipped.slice(cut + 1));
  }

  private line(at: number, fragment: string, message: string, stack: string): void {
    const field = (s: string) => s.replaceAll('\t', ' ').replaceAll('\r', '').replaceAll('\n', '\\n');
    this.write(`${[new Date(at).toISOString(), this.surface, `#${fragment}`, message, stack].map(field).join('\t')}\n`);
  }
}
