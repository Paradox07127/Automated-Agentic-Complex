// 日志's 复制所选: the picked lines as plain text for an issue report, under the app's version, commit and OS.
import type { AppInfo } from '../../bridge/appInfo';
import type { LogLine } from '../../bridge/logs';
import { isoWithOffset } from '../../domain/units';
import { LEVEL_NAME, LOG_NAME } from './useLogs';

const CODE = /\b(?:error_code|code)=([^\s,;)]+)|"code":\s*"([^"]+)"/;
const ID = /\b(turn_id|trace_id)=([\w-]+)/;

const buildOf = (i: AppInfo) => (i.source === 'dev' ? `dev ${i.devCommit.slice(0, 9)}${i.devDirty ? ' dirty' : ''}` : i.buildGit);

/** One block per line; the same words again from the same source fold into one block with ×N, as the list shows them. */
export function logReport(lines: readonly LogLine[], info: AppInfo | null): string {
  const out: string[] = [];
  if (info) out.push(`Agentic Complex ${info.version} │ ${buildOf(info)} │ ${info.os}`);
  out.push(`日志 ${lines.length} 条`);
  let no = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    let times = 1;
    while (i + times < lines.length && lines[i + times]!.source === l.source && lines[i + times]!.text === l.text && lines[i + times]!.level === l.level) times += 1;
    i += times - 1;
    no += 1;
    const all = [l.text, ...l.more].join('\n');
    const code = CODE.exec(all);
    const id = ID.exec(all);
    out.push(
      '',
      `#${no} ${l.at != null ? isoWithOffset(l.at) : '—'} │ ${LEVEL_NAME[l.level]} │ ${LOG_NAME[l.source]} (${l.source})${times > 1 ? ` │ ×${times}` : ''}`,
      l.text,
      ...l.more,
      ...(code ? [`code: ${code[1] ?? code[2]}`] : []),
      ...(id ? [`${id[1]}: ${id[2]}`] : l.turn ? [`turn: ${l.turn}`] : []),
    );
  }
  return out.join('\n');
}
