import type { ReactNode } from 'react';
import { DevMark, InfoTip, ModLine } from '../../ui';
import { useSettings } from './ctx';
import { REGISTRY, useRowShown } from './registry';
import styles from './rows.module.css';

export interface SetRowProps {
  id: string;
  title: string;
  /** The one line under the title; the rest goes in `info`. */
  desc?: ReactNode;
  descTone?: 'attention' | 'bad' | 'ok';
  /** ⓘ beside the title. */
  info?: string;
  control: ReactNode;
  /** Child row of the row or band above, drawn indented. */
  indent?: boolean;
  /** Label and control top-aligned, for a row whose description holds a list. */
  tall?: boolean;
  /** The controls wrap onto a second line. */
  wrap?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  children?: ReactNode;
}

const DEV: ReadonlySet<string> = new Set(REGISTRY.filter((r) => r.dev).map((r) => r.id));

/**
 * One settings row: title, ⓘ and marks (deletes data, waits for a restart, not applied, developer), one description line, the
 * control column; a config.json row off its default gets the shared modified line. Absent while its plug-in is off, or outside 开发者模式 for a developer row. A read-only group's cause stays in
 * the bar above it.
 */
export function SetRow({ id, title, desc, descTone, info, control, indent, tall, wrap, disabled, disabledReason, children }: SetRowProps) {
  const { model, ro, hl, native } = useSettings();
  const shown = useRowShown();
  if (!shown(id)) return null;
  const off = disabled || ro;
  const descId = `set-${id}-desc`;
  const modId = `set-${id}-mod`;
  const def = native?.rows[id]?.default;
  const modified = def !== undefined && JSON.stringify(model.value(id)) !== JSON.stringify(def);
  const described = [desc != null ? descId : '', modified ? modId : ''].filter(Boolean).join(' ');
  return (
    <div
      id={`set-${id}`}
      role="group"
      aria-labelledby={`set-${id}-title`}
      aria-describedby={described || undefined}
      aria-disabled={off || undefined}
      title={off && !ro ? disabledReason : undefined}
      className={[styles.row, hl === id && styles.hl].filter(Boolean).join(' ')}
      data-row={id}
      data-nav-target={`set-${id}`}
      data-sub={indent || undefined}
      data-tall={tall || undefined}
      data-modified={modified || undefined}
    >
      <div className={styles.lab}>
        <div className={styles.tt}>
          <span id={`set-${id}-title`}>{title}</span>
          {info && <InfoTip>{info}</InfoTip>}
          {native?.rows[id]?.destructive && (
            <span className={styles.mark} data-k="del">
              关掉会删数据
            </span>
          )}
          {model.pending[id] && (
            <span className={styles.mark} data-k="re">
              ⟳ 重启后台后生效
            </span>
          )}
          {id in model.draft && (
            <span className={styles.mark} data-k="draft">
              未应用
            </span>
          )}
          {DEV.has(id) && <DevMark />}
          {modified && <ModLine id={modId} />}
        </div>
        {desc != null && (
          <div id={descId} className={styles.d} data-tone={descTone}>
            {desc}
          </div>
        )}
      </div>
      <div className={styles.ctl} data-wrap={wrap || undefined} inert={off || undefined}>
        {model.ok === id && (
          <span className={styles.ok} aria-live="polite">
            ✓ 已保存
          </span>
        )}
        {control}
      </div>
      {children != null && <div className={styles.extra}>{children}</div>}
    </div>
  );
}
