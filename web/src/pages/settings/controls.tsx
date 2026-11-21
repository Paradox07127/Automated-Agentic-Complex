import { Seg, Select, Toggle } from '../../ui';
import { useSettings } from './ctx';
import { targetOf, type Opt } from './fields';
import { optionsOf } from './native';
import { labelOf } from './registry';
import { Stepper } from './Stepper';
import styles from './groups.module.css';

const OFF_REASON = '后台服务没有运行，这一项暂时只读';

/**
 * Control factories bound to the settings model: each reads the draft-or-saved value and writes through `model.set`. Native rows take their options from the schema.
 * An agentd row is read-only while agentd is down, and a switch agentd has not answered for reads「未读到」rather than off.
 */
export function useControls() {
  const { model, ro: groupRo, roReason, agentdOff, demo, item, native, schema } = useSettings();
  const v = model.value;
  const lock = (id: string) => groupRo || (agentdOff && targetOf(id) != null);
  const why = (id: string, reason?: string) => (groupRo ? roReason : lock(id) ? OFF_REASON : reason);
  const opts = (id: string, given?: Opt[]) => given ?? optionsOf(native?.rows[id] ?? schema?.[id]);
  return {
    toggle: (id: string, label = labelOf(id), dis?: boolean, reason?: string) =>
      targetOf(id) && v(id) === undefined ? (
        <span className={styles.t3} title={`${label}：还没读到后台的设置`}>
          未读到
        </span>
      ) : (
        <Toggle on={v(id) === true} label={label} size="sm" disabled={lock(id) || dis} disabledReason={why(id, reason)} onChange={(on) => model.set(id, on)} />
      ),
    seg: (id: string, given?: Opt[], dis?: boolean) => (
      <Seg
        label={labelOf(id)}
        size="sm"
        value={String(v(id) ?? '')}
        options={opts(id, given).map((o) => ({ value: o.value, label: o.label, disabled: lock(id) || dis || o.disabled }))}
        onChange={(x) => model.set(id, x)}
      />
    ),
    select: (id: string, given?: Opt[], risky: string[] = [], dis?: boolean, label = labelOf(id)) => {
      const d = native?.rows[id]?.default;
      return (
        <Select
          label={label}
          value={String(v(id) ?? '')}
          defaultValue={d == null ? undefined : String(d)}
          options={opts(id, given).map((o) => ({ value: o.value, label: o.label, risky: risky.includes(o.value) }))}
          open={demo === 'dropdown-open' && (item ?? 'proactive') === id}
          disabled={lock(id) || dis}
          onChange={(x) => model.set(id, x)}
        />
      );
    },
    stepper: (id: string, min: number, max: number, step: number, format?: (n: number) => string, dis?: boolean, reason?: string) => (
      <Stepper
        label={labelOf(id)}
        value={Number(v(id) ?? min)}
        min={min}
        max={max}
        step={step}
        format={format}
        disabled={lock(id) || dis}
        disabledReason={why(id, reason)}
        onChange={(n) => model.set(id, n)}
      />
    ),
    /** Free text written on blur or Enter (model ids, URLs). */
    text: (id: string, label: string, placeholder?: string, dis?: boolean) => (
      <input
        key={`${id}:${String(v(id) ?? '')}`}
        className={styles.input}
        aria-label={label}
        placeholder={placeholder}
        defaultValue={String(v(id) ?? '')}
        disabled={lock(id) || dis}
        onBlur={(e) => e.currentTarget.value !== String(v(id) ?? '') && model.set(id, e.currentTarget.value.trim())}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    ),
  };
}
