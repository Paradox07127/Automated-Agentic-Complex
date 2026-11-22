import type { ReactNode } from 'react';
import { MessageCode } from './MessageCode';
import { LinkCard, MessageImage, MessageLink, webUrl } from './LinkConfirm';
import styles from './Messages.module.css';

const KEYWORD = /(~\/[^\s，。、「」]+|[\w-]+\.(?:md|csv|swift|json|log)|\b[A-Z][a-z]+[A-Z][A-Za-z]+\b)/;
/** One inline mark: code, image, link, bold, italic (* or _), or a bare web address. */
const INLINE = /(`[^`\n]+`)|!\[([^\]\n]*)\]\(([^)\s]+)\)|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+?)\*\*|\*([^*\s][^*\n]*?)\*|(?<![\p{L}\p{N}_])_([^_\n]+?)_(?![\p{L}\p{N}_])|(https?:\/\/[^\s<>"'`（）「」【】，。、；：！？]+)/gu;
/** Punctuation that ends a sentence rather than the address it follows. */
const URL_TAIL = /[.,;:!?)\]]+$/;
const BULLET = /^\s*[-*+]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const HEADING = /^#{1,6}\s+/;
const QUOTE = /^\s*>\s?/;
const BARE_URL = /^\s*(https?:\/\/\S+)\s*$/;

function words(text: string, key: string) {
  return text.split(KEYWORD).map((word, j) => (j % 2 ? <span key={`${key}-${j}`} className={styles.kw}>{word}</span> : word));
}

/** Inline marks; without `live` (the desktop bubble) links and images stay their words. */
function inline(text: string, live: boolean, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    const k = `${key}-${m.index}`;
    let whole = m[0];
    const [, code, alt, src, label, href, bold, star, under, bare] = m;
    if (bare) whole = bare.replace(URL_TAIL, '');
    out.push(...words(text.slice(at, m.index), `${k}w`));
    at = m.index + whole.length;
    if (code) out.push(<code className={styles.kw} key={k}>{code.slice(1, -1)}</code>);
    else if (src != null) out.push(live && (webUrl(src) || /^data:image\//.test(src)) ? <MessageImage key={k} src={src} alt={alt ?? ''} /> : (alt ?? ''));
    else if (label != null) out.push(live && webUrl(href!) ? <MessageLink key={k} href={href!}>{inline(label, live, k)}</MessageLink> : <span key={k}>{inline(label, live, k)}</span>);
    else if (bold != null) out.push(<strong key={k}>{inline(bold, live, k)}</strong>);
    else if (star != null || under != null) out.push(<em key={k}>{inline((star ?? under)!, live, k)}</em>);
    else out.push(live && webUrl(whole) ? <MessageLink key={k} href={whole}>{whole}</MessageLink> : whole);
  }
  out.push(...words(text.slice(at), `${key}-end`));
  return out;
}

function tableCells(line: string) {
  return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function markdownTable(lines: string[], key: string, live: boolean) {
  if (lines.length < 2 || !lines[0]?.includes('|')) return null;
  const [header, divider, ...rows] = lines.map(tableCells);
  if (!header || !divider || header.length < 2 || divider.length !== header.length || !divider.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  if (!rows.every((cells) => cells.length === header.length)) return null;
  return (
    <div className={styles.messageTable} key={key}>
      <table>
        <thead><tr>{header.map((cell, index) => <th key={index} scope="col">{inline(cell, live)}</th>)}</tr></thead>
        <tbody>{rows.map((cells, row) => <tr key={row}>{cells.map((cell, col) => <td key={col}>{inline(cell, live)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Which block a line belongs to. */
function kindOf(line: string, live: boolean): 'heading' | 'ul' | 'ol' | 'quote' | 'url' | 'text' {
  if (HEADING.test(line)) return 'heading';
  if (BULLET.test(line)) return 'ul';
  if (NUMBERED.test(line)) return 'ol';
  if (QUOTE.test(line)) return 'quote';
  if (live && BARE_URL.test(line) && webUrl(line.trim())) return 'url';
  return 'text';
}

function paragraph(text: string, key: string, live: boolean) {
  const lines = text.split('\n');
  const table = markdownTable(lines, key, live);
  if (table) return table;
  const groups: Array<{ kind: ReturnType<typeof kindOf>; lines: string[] }> = [];
  for (const line of lines) {
    const kind = kindOf(line, live);
    const last = groups.at(-1);
    if (last && last.kind === kind && kind !== 'heading' && kind !== 'url') last.lines.push(line);
    else groups.push({ kind, lines: [line] });
  }
  return groups.map(({ kind, lines }, index) => {
    const id = `${key}-${index}`;
    const first = lines[0] ?? '';
    if (kind === 'heading') return <strong className={styles.messageHeading} key={id}>{inline(first.replace(HEADING, ''), live, id)}</strong>;
    if (kind === 'url') return <LinkCard key={id} href={first.trim()} />;
    if (kind === 'ul' || kind === 'ol') {
      const List = kind;
      return <List key={id}>{lines.map((line, i) => <li key={i}>{inline(line.replace(kind === 'ul' ? BULLET : NUMBERED, ''), live, `${id}-${i}`)}</li>)}</List>;
    }
    if (kind === 'quote') return <blockquote key={id}>{inline(lines.map((l) => l.replace(QUOTE, '')).join('\n'), live, id)}</blockquote>;
    return <div key={id}>{inline(lines.join('\n'), live, id)}</div>;
  });
}

/** A reply's blocks; while it streams, one inline run, so an open fence stays text. Without `live` there are no copy buttons and links and images stay words. */
export function messageBlocks(text: string, streaming?: boolean, live = true) {
  if (streaming) return inline(text, live);
  return text.split(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm).map((section, i) => i % 2
    ? live ? <MessageCode code={section.trimEnd()} key={i} /> : <pre className={styles.messageCode} key={i}><code>{section.trimEnd()}</code></pre>
    : section.trim().split(/\n\s*\n/).filter(Boolean).map((p, j) => paragraph(p, `${i}-${j}`, live)));
}

/** Structured text and code; raw HTML stays text, and only http(s) addresses become links. */
export function MessageText({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={styles.text} aria-live={streaming ? 'polite' : undefined}>
      {messageBlocks(text, streaming)}
      {streaming && <span className={styles.cursor} aria-hidden="true" />}
    </div>
  );
}
