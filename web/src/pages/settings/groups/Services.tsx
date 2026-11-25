import type { ReactNode } from 'react';
import type { RuntimeService } from '../../../bridge/runtimeSnapshot';
import type { VisualStateKey } from '../../../domain/states';
import type { ServiceId, ServiceMode, ServiceRecord } from '../../../bridge/services';
import { voiceText } from '../../../domain/voiceState';
import { Field, IconBtn } from '../../../ui';
import { GameSeg, StatusLamp } from '../../../ui/game';
import { useSettings } from '../ctx';
import { draftOf, problem, recordOf, SERVICE_NAME, serviceRow, type ServiceDraft } from '../servicesDraft';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import { LlmSecretRows, MotionTokenRow } from './ServiceSecrets';
import { VOICE_TONE } from './Speak';
import { TtsSecretRows } from './SpeakService';
import rows from '../rows.module.css';
import styles from './Services.module.css';

export interface ServicesGroupProps {
  /** The saved records, as config.json holds them. */
  records: Record<ServiceId, ServiceRecord>;
  runtimes: Record<ServiceId, RuntimeService | null>;
  onStart: (id: ServiceId) => void;
  onStop: (id: ServiceId) => void;
  onRestart: (id: ServiceId) => void;
  onLogs: (id: ServiceId) => void;
  disabled: boolean;
}

/** Each service and what uses it. */
const SERVICES: Array<[ServiceId, string]> = [
  ['tts', '用于语音播报'],
  ['motion', '用于生成角色动作'],
  ['llm', 'Pi 选择「兼容 API」时使用'],
];

const MODES: Array<{ value: ServiceMode; label: string }> = [
  { value: 'off', label: '关闭' },
  { value: 'url', label: '地址' },
  { value: 'ssh', label: 'SSH' },
  { value: 'local', label: '本机' },
];
const MODE_LABEL = Object.fromEntries(MODES.map((m) => [m.value, m.label])) as Record<ServiceMode, string>;

const STATE: Record<string, [VisualStateKey, string]> = {
  stopped: ['stopped', '未启动'],
  starting: ['waiting', '启动中'],
  running: ['ok', '运行中'],
  backoff: ['waiting', '重连中'],
  port_in_use: ['broken', '端口被占用'],
  failed: ['broken', '启动失败'],
  external: ['ok', '沿用已有转发'],
};
const LIVE: ReadonlySet<string> = new Set(['running', 'starting', 'backoff']);

const OFF_REASON = '当前不可操作';

/** 服务: one card per self-hosted service; a change is a draft of the page, applied whole with the bottom bar. */
export function ServicesGroup({ records, runtimes, disabled, ...on }: ServicesGroupProps) {
  return (
    <SetSection
      title="自建服务"
      info="仅 SSH 与本机模式由应用托管启停。修改后须点击底部「应用」，生效后将自动重启对应服务与后台服务。更换服务地址将清除原有的访问令牌或 API Key。"
    >
      {SERVICES.map(([id, use]) => (
        <Service key={id} id={id} use={use} record={records[id]} runtime={runtimes[id]} disabled={disabled} {...on} />
      ))}
    </SetSection>
  );
}

type ServiceProps = Omit<ServicesGroupProps, 'records' | 'runtimes'> & { id: ServiceId; use: string; record: ServiceRecord; runtime: RuntimeService | null };

/** A card: name, who uses it, the lamp, start/stop and 接法 on its head; the fields of the 接法 picked, then its secret and test. */
function Service({ id, use, record, runtime, disabled, onStart, onStop, onRestart, onLogs }: ServiceProps) {
  const { model, hl, diag } = useSettings();
  const row = serviceRow(id);
  const name = SERVICE_NAME[id];
  const held = model.draft[row];
  const dirty = typeof held === 'string';
  const draft: ServiceDraft = dirty ? (JSON.parse(held) as ServiceDraft) : draftOf(record);
  const why = problem(recordOf(draft));
  const refused = model.rejected[row];
  // Shown once the draft differs, so an untouched card is not red.
  const bad = (key: string) => (dirty && why?.[0] === key ? why[1] : refused?.field === key ? refused.message : undefined);
  const put = (patch: Partial<ServiceDraft>) => {
    const next = { ...draft, ...patch };
    model.setDraft(({ [row]: _old, ...rest }) => (JSON.stringify(next) === JSON.stringify(draftOf(record)) ? rest : { ...rest, [row]: JSON.stringify(next) }));
  };

  // The lamp and the run controls describe the saved record, which is what runs.
  const managed = record.mode === 'ssh' || record.mode === 'local';
  // A reply about another mode describes what ran before the last save.
  const rt = runtime?.mode === record.mode ? runtime : null;
  const kind = rt?.state?.kind;
  const live = kind != null && LIVE.has(kind);
  let lamp: ReactNode = null;
  if (record.mode === 'off') lamp = <StatusLamp size="sm" state="stopped" label="未启用" />;
  else if (managed) {
    const [tone, text]: [VisualStateKey, string] = kind ? (STATE[kind] ?? ['idle', kind]) : ['idle', '未读取'];
    lamp = <StatusLamp size="sm" state={tone} label={text} />;
  } else if (id === 'tts') lamp = diag.voice ? <StatusLamp size="sm" state={VOICE_TONE[diag.voice.state]} label={voiceText(diag.voice.state, null)} /> : <StatusLamp size="sm" state="idle" label="未读取" />;
  const note = managed ? [rt?.state?.reason, rt?.detail].filter(Boolean).join(' │ ') : '';

  const field = (key: 'url' | 'ssh_host' | 'start_script' | 'cwd' | 'command', title: string, placeholder?: string, hint?: string) => (
    <SetRow
      id={`svc_${id}_${key}`}
      title={title}
      desc={bad(key) ?? hint}
      descTone={bad(key) ? 'bad' : undefined}
      control={
        <Field
          label={`${name} ${title}`}
          invalid={bad(key) != null}
          placeholder={placeholder}
          value={draft[key]}
          disabled={disabled}
          spellCheck={false}
          onChange={(v) => put({ [key]: v })}
        />
      }
    />
  );

  return (
    <section
      id={`set-${row}`}
      aria-label={name}
      className={[styles.card, hl === row && rows.hl].filter(Boolean).join(' ')}
      data-row={row}
      data-nav-target={`set-${row}`}
    >
      <header className={styles.head}>
        <div className={styles.title}>
          <h4 className={styles.name}>{name}</h4>
          <span className={styles.use}>{use}</span>
          {dirty && (
            <span className={rows.mark} data-k="draft">
              未应用 │ 当前：{MODE_LABEL[record.mode]}
            </span>
          )}
        </div>
        <div className={styles.ctl}>
          {lamp}
          {managed && rt?.pid != null && <span className={styles.pid}>PID {rt.pid}</span>}
          {managed && kind !== 'external' &&
            (live ? (
              <IconBtn icon="stop" label={`停止${name}`} disabled={disabled} disabledReason={OFF_REASON} onClick={() => onStop(id)} />
            ) : (
              <IconBtn icon="play" label={`启动${name}`} disabled={disabled || !rt} disabledReason={disabled ? OFF_REASON : '尚未读取状态'} onClick={() => onStart(id)} />
            ))}
          {managed && live && kind !== 'starting' && <IconBtn icon="refresh" label={`重启${name}`} disabled={disabled} disabledReason={OFF_REASON} onClick={() => onRestart(id)} />}
          {managed && <IconBtn icon="file" label={`${name}日志`} disabled={disabled} disabledReason={OFF_REASON} onClick={() => onLogs(id)} />}
          <GameSeg variant="setting" label={`${name} 连接方式`} value={draft.mode} options={MODES} disabled={disabled} onChange={(v) => put({ mode: v as ServiceMode })} />
        </div>
      </header>
      {note && <p className={styles.note}>{note}</p>}
      {draft.mode !== 'off' && (
        <div className={styles.body}>
          {field('url', '地址', draft.mode === 'url' ? 'http://主机:端口' : 'http://127.0.0.1:端口', draft.mode === 'ssh' ? '本机隧道映射地址' : undefined)}
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
          {id === 'tts' && <TtsSecretRows pending={dirty} />}
          {id === 'motion' && <MotionTokenRow pending={dirty} />}
          {id === 'llm' && <LlmSecretRows pending={dirty} />}
        </div>
      )}
    </section>
  );
}
