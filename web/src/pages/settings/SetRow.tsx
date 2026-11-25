import type { ReactNode } from 'react';
import { DevMark, Receipt, SRow } from '../../ui';
import { PowerState } from '../../ui/game';
import { useSettings } from './ctx';
import { REGISTRY, useHelperLacks, useRowShown } from './registry';
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
 * One settings row (the shared SRow): title, ⓘ and marks (deletes data, waits for a restart, not applied, developer), one description line, the
 * control column; a config.json row off its default gets the shared modified line. Absent while its plug-in is off, or outside 开发者模式 for a developer row. A read-only group's cause stays in
 * the bar above it. A row whose helper ops are missing stays, under a 未接入 strip that leads to 系统权限.
 */
export function SetRow(p: SetRowProps) {
  const { goRow } = useSettings();
  const shown = useRowShown();
  const lacks = useHelperLacks();
  if (!shown(p.id)) return null;
  if (!lacks(p.id)) return <Row {...p} />;
  return (
    <PowerState
      state="unlinked"
      mode="block"
      title="系统辅助组件"
      reason="尚未检测到所需系统辅助能力，请先检查对应系统权限是否已授予"
      action={{ label: '查看系统权限', onClick: () => goRow('perms', 'perm') }}
    >
      <Row {...p} />
    </PowerState>
  );
}

function Row({ id, title, desc, descTone, info, control, indent, tall, wrap, disabled, disabledReason, children }: SetRowProps) {
  const { model, ro, hl, native } = useSettings();
  const off = disabled || ro;
  const def = native?.rows[id]?.default;
  const modified = def !== undefined && JSON.stringify(model.value(id)) !== JSON.stringify(def);
  return (
    <SRow
      id={id}
      title={title}
      desc={desc}
      descTone={descTone}
      tip={info}
      marks={
        <>
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
        </>
      }
      control={
        <>
          {model.ok === id && <Receipt>已保存</Receipt>}
          {control}
        </>
      }
      indent={indent}
      tall={tall}
      wrap={wrap}
      disabled={off}
      disabledReason={ro ? undefined : disabledReason}
      modified={modified}
      className={hl === id ? styles.hl : undefined}
      data-row={id}
      data-nav-target={`set-${id}`}
    >
      {children}
    </SRow>
  );
}
