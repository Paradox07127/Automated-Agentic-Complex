import { useState } from 'react';
import type { RuntimeService } from '../../../bridge/runtimeSnapshot';
import type { ServiceId, ServiceMode, ServiceRecord } from '../../../bridge/services';
import { Btn, IconBtn } from '../../../ui';
import { ExpandRow, GameSeg } from '../../../ui/game';
import { Field, St, type StTone } from '../kit';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import groups from '../groups.module.css';
import styles from './Services.module.css';

/** A field the shell refused on the last save, with its reason. */
export interface ServiceRejected { id: ServiceId; field: string; message: string }

export interface ServicesGroupProps {
  records: Record<ServiceId, ServiceRecord>;
  runtimes: Record<ServiceId, RuntimeService | null>;
  rejected?: ServiceRejected | null;
  onSave: (id: ServiceId, record: ServiceRecord) => void;
  onStart: (id: ServiceId) => void;
  onStop: (id: ServiceId) => void;
  onRestart: (id: ServiceId) => void;
  onLogs: (id: ServiceId) => void;
  disabled: boolean;
}

const SERVICES: Array<[ServiceId, string]> = [
  ['tts', '语音服务'],
  ['motion', '动作服务'],
  ['llm', '模型服务'],
];

const MODES: Array<{ value: ServiceMode; label: string }> = [
  { value: 'off', label: '关' },
  { value: 'url', label: '地址' },
  { value: 'ssh', label: 'SSH' },
  { value: 'local', label: '本机' },
];
const MODE_LABEL = Object.fromEntries(MODES.map((m) => [m.value, m.label])) as Record<ServiceMode, string>;

const STATE: Record<string, [StTone, string]> = {
  stopped: ['off', '未启动'],
  starting: ['warn', '启动中'],
  running: ['ok', '运行中'],
  backoff: ['warn', '重连中'],
  port_in_use: ['bad', '端口被占用'],
  failed: ['bad', '失败'],
  external: ['ok', '沿用已有转发'],
};
const LIVE: ReadonlySet<string> = new Set(['running', 'starting', 'backoff']);

const OFF_REASON = '现在不能操作';

/** The command field as argv: whitespace splits, a quoted span stays whole and loses its quotes. */
export function splitCommand(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** argv back into the field, quoting what splitCommand would otherwise split or strip. */
export function joinCommand(argv: string[]): string {
  return argv.map((a) => (a !== '' && !/[\s"']/.test(a) ? a : a.includes('"') ? `'${a}'` : `"${a}"`)).join(' ');
}

const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The field that keeps a draft from being saved, and why; null when it can be. */
function problem(d: ServiceRecord): ['url' | 'ssh_host' | 'command', string] | null {
  if (d.mode === 'off') return null;
  let u: URL | null = null;
  try {
    u = new URL(d.url.trim());
  } catch {
    // stays null
  }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return ['url', '地址要以 http:// 或 https:// 开头'];
  if (d.mode === 'url') return null;
  if (!LOOPBACK.has(u.hostname) || !u.port) return ['url', '要填回环地址和端口'];
  if (d.mode === 'ssh' && !d.ssh_host.trim()) return ['ssh_host', 'SSH 主机没填'];
  if (d.mode === 'local' && d.command.length === 0) return ['command', '命令没填'];
  return null;
}

/** 服务: the voice, motion and model services, each with its state and start/stop, and how it is reached folded under it. */
export function ServicesGroup({ records, runtimes, rejected, disabled, ...on }: ServicesGroupProps) {
  return (
    <SetSection title="服务">
      {SERVICES.map(([id, name]) => (
        <Service key={`${id}:${JSON.stringify(records[id])}`} id={id} name={name} record={records[id]} runtime={runtimes[id]} rejected={rejected?.id === id ? rejected : null} disabled={disabled} {...on} />
      ))}
    </SetSection>
  );
}

type ServiceProps = Omit<ServicesGroupProps, 'records' | 'runtimes'> & { id: ServiceId; name: string; record: ServiceRecord; runtime: RuntimeService | null };

/** A service's state row, then its fold; the draft resets whenever the saved record changes. */
function Service({ id, name, record, runtime, rejected, disabled, onSave, onStart, onStop, onRestart, onLogs }: ServiceProps) {
  const [draft, setDraft] = useState(record);
  const [command, setCommand] = useState(() => joinCommand(record.command));
  const managed = record.mode === 'ssh' || record.mode === 'local';
  // A reply about another mode describes what ran before the last save.
  const rt = runtime?.mode === record.mode ? runtime : null;
  const kind = rt?.state?.kind;
  const [tone, text]: [StTone, string] = kind ? (STATE[kind] ?? ['off', kind]) : ['off', '未读到'];
  const reason = managed ? rt?.state?.reason : undefined;
  const detail = managed ? rt?.detail : null;
  const live = kind != null && LIVE.has(kind);
  const desc = [reason, detail].filter(Boolean).join(' │ ') || undefined;

  const next: ServiceRecord = { ...draft, command: splitCommand(command) };
  const dirty = JSON.stringify(next) !== JSON.stringify(record);
  const why = problem(next);
  // Shown once the draft differs, so an untouched fold is not red.
  const bad = (key: string) => (dirty && why?.[0] === key ? why[1] : rejected?.field === key ? rejected.message : undefined);
  const set = (patch: Partial<ServiceRecord>) => setDraft((d) => ({ ...d, ...patch }));
  const field = (key: 'url' | 'ssh_host' | 'start_script' | 'cwd' | 'command', title: string, placeholder?: string) => (
    <SetRow
      id={`svc_${id}_${key}`}
      title={title}
      desc={bad(key)}
      descTone="bad"
      control={
        <Field
          aria-label={`${name} ${title}`}
          aria-invalid={bad(key) != null || undefined}
          placeholder={placeholder}
          value={key === 'command' ? command : draft[key]}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => (key === 'command' ? setCommand(e.currentTarget.value) : set({ [key]: e.currentTarget.value }))}
        />
      }
    />
  );

  const body = (
    <>
      <SetRow
        id={`svc_${id}_mode`}
        title="接法"
        control={<GameSeg variant="setting" label={`${name} 接法`} value={draft.mode} options={MODES} disabled={disabled} onChange={(v) => set({ mode: v as ServiceMode })} />}
      />
      {draft.mode !== 'off' && field('url', '地址', draft.mode === 'url' ? 'http://主机:端口' : 'http://127.0.0.1:端口')}
      {draft.mode === 'ssh' && (
        <>
          {field('ssh_host', 'SSH 主机')}
          {field('start_script', '启动脚本')}
        </>
      )}
      {draft.mode === 'local' && (
        <>
          {field('command', '命令')}
          {field('cwd', '工作目录')}
        </>
      )}
      {dirty && (
        <div className={styles.foot}>
          <Btn disabled={disabled || why != null} disabledReason={why?.[1] ?? OFF_REASON} onClick={() => onSave(id, next)}>
            保存
          </Btn>
        </div>
      )}
    </>
  );

  const summary = [record.mode !== 'off' && record.url, record.mode === 'ssh' && record.ssh_host, managed && rt?.pid != null && `pid ${rt.pid}`].filter(Boolean).join(' │ ');
  return (
    <>
      <SetRow
        id={`svc_${id}`}
        title={name}
        desc={desc}
        descTone={reason ? 'bad' : undefined}
        control={
          // Off and url run nothing here; the fold right below names the mode.
          managed && (
            <>
              <St tone={tone}>{text}</St>
              {kind !== 'external' &&
                (live ? (
                  <IconBtn icon="stop" label={`停止${name}`} disabled={disabled} disabledReason={OFF_REASON} onClick={() => onStop(id)} />
                ) : (
                  <IconBtn icon="play" label={`启动${name}`} disabled={disabled || !rt} disabledReason={disabled ? OFF_REASON : '还没读到状态'} onClick={() => onStart(id)} />
                ))}
              {live && kind !== 'starting' && <IconBtn icon="refresh" label={`重启${name}`} disabled={disabled} disabledReason={OFF_REASON} onClick={() => onRestart(id)} />}
              <IconBtn icon="file" label={`${name}日志`} disabled={disabled} disabledReason={OFF_REASON} onClick={() => onLogs(id)} />
            </>
          )
        }
      />
      <div className={groups.sub}>
        <ExpandRow label={`${name} 接法`} body={body}>
          <span>{MODE_LABEL[record.mode]}</span>
          {summary && <span className={groups.t3}>{summary}</span>}
        </ExpandRow>
      </div>
    </>
  );
}
