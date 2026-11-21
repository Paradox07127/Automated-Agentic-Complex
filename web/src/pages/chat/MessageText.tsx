import { MessageCode } from './MessageCode';
import styles from './Messages.module.css';

const KEYWORD = /(~\/[^\s，。、「」]+|[\w-]+\.(?:md|csv|swift|json|log)|\b[A-Z][a-z]+[A-Z][A-Za-z]+\b)/;
const LINK = /\[([^\]\n]+)\]\([^)\s]+\)/g;
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/;
const BULLET = /^(?:\s*[-*+]\s+|\s*\d+[.)]\s+)/;
const HEADING = /^#{1,6}\s+/;

function inline(text: string) {
  return text.replace(LINK, '$1').split(INLINE).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && i % 2 === 1) return <code className={styles.kw} key={i}>{part.slice(1, -1)}</code>;
    if (i % 2 === 1) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return part.split(KEYWORD).map((word, j) => j % 2 ? <span key={`${i}-${j}`} className={styles.kw}>{word}</span> : word);
  });
}

function tableCells(line: string) {
  return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function markdownTable(lines: string[], key: string) {
  if (lines.length < 2 || !lines[0]?.includes('|')) return null;
  const [header, divider, ...rows] = lines.map(tableCells);
  if (!header || !divider || header.length < 2 || divider.length !== header.length || !divider.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  if (!rows.every((cells) => cells.length === header.length)) return null;
  return (
    <div className={styles.messageTable} key={key}>
      <table>
        <thead><tr>{header.map((cell, index) => <th key={index} scope="col">{inline(cell)}</th>)}</tr></thead>
        <tbody>{rows.map((cells, row) => <tr key={row}>{cells.map((cell, col) => <td key={col}>{inline(cell)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function paragraph(text: string, key: string) {
  const lines = text.split('\n');
  const table = markdownTable(lines, key);
  if (table) return table;
  const groups: string[][] = [];
  for (const line of lines) {
    const last = groups.at(-1);
    if (last && !HEADING.test(line) && !HEADING.test(last[0] ?? '') && BULLET.test(line) === BULLET.test(last[0] ?? '')) last.push(line);
    else groups.push([line]);
  }
  return groups.map((lines, index) => {
    const first = lines[0] ?? '';
    const id = `${key}-${index}`;
    if (HEADING.test(first)) return <strong className={styles.messageHeading} key={id}>{inline(first.replace(HEADING, ''))}</strong>;
    if (BULLET.test(first)) {
      const List = /^\s*\d/.test(first) ? 'ol' : 'ul';
      return <List key={id}>{lines.map((line, i) => <li key={i}>{inline(line.replace(BULLET, ''))}</li>)}</List>;
    }
    return <div key={id}>{inline(lines.join('\n'))}</div>;
  });
}

/** A reply's blocks; while it streams, one inline run, so an open fence stays text. */
export function messageBlocks(text: string, streaming?: boolean, copy = true) {
  if (streaming) return inline(text);
  return text.split(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm).map((section, i) => i % 2
    ? copy ? <MessageCode code={section.trimEnd()} key={i} /> : <pre className={styles.messageCode} key={i}><code>{section.trimEnd()}</code></pre>
    : section.trim().split(/\n\s*\n/).filter(Boolean).map((p, j) => paragraph(p, `${i}-${j}`)));
}

/** Structured text and code, with no raw HTML or unverified file links. */
export function MessageText({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={styles.text} aria-live={streaming ? 'polite' : undefined}>
      {messageBlocks(text, streaming)}
      {streaming && <span className={styles.cursor} aria-hidden="true" />}
    </div>
  );
}
