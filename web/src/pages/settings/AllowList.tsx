import { useState, type ReactNode } from 'react';
import { Btn, IconBtn, Select } from '../../ui';
import { Field } from './kit';
import { addAllow, failure, removeAllow } from './api';
import { useSettings } from './ctx';
import { Slab } from './Slab';
import type { AllowField } from './wire';
import styles from './groups.module.css';

const FIELD: Array<{ value: AllowField; label: string; hint: string }> = [
  { value: 'app_names', label: '应用名', hint: '例如 微信' },
  { value: 'bundle_ids', label: '应用 ID', hint: '例如 com.tencent.xinWeChat' },
  { value: 'domains', label: '网站', hint: '例如 mail.qq.com' },
];
const PREFIX: Record<AllowField, string> = { app_names: '应用', bundle_ids: '应用', domains: '网站' };
/** Chips shown before「全部 N 项」. */
const FOLD = 8;

/** ExcludeList in mode allow: only the windows on agentd's allow list are read; `right` is the mode control. */
export function AllowList({ right }: { right: ReactNode }) {
  const { model, ro: groupRo, agentdOff, blacklist, reload } = useSettings();
  const ro = groupRo || agentdOff;
  const [field, setField] = useState<AllowField>('app_names');
  const [value, setValue] = useState('');
  const [all, setAll] = useState(false);
  const fail = (what: string) => (e: unknown) => model.notify({ message: `${what}：${failure(e).text}`, severity: 'danger', persistent: true });

  const entries = blacklist ? FIELD.flatMap((f) => blacklist.allow[f.value].map((v) => ({ field: f.value, value: v }))) : [];
  const shown = all ? entries : entries.slice(0, FOLD);
  const add = () => {
    const v = value.trim();
    if (!v) return;
    void addAllow(field, v).then(() => {
      setValue('');
      reload('blacklist');
      model.notify({ message: `已添加「${v}」` });
    }, fail(`没能添加「${v}」`));
  };
  const remove = (f: AllowField, v: string) =>
    void removeAllow(f, v).then(() => {
      reload('blacklist');
      model.notify({ message: `已移除「${v}」，以后不再读取` });
    }, fail(`没能移除「${v}」`));

  return (
    <Slab id="exclude" title="只读取这些应用和网站" right={right}>
      <div className={styles.chips}>
        {entries.length === 0 && <span className={styles.t2}>什么都不读</span>}
        {shown.map((x) => (
          <span key={`${x.field}:${x.value}`} className={styles.xchip}>
            {PREFIX[x.field]} │ {x.value}
            <IconBtn icon="close" size="sm" label={`移除 ${x.value}`} disabled={ro} onClick={() => remove(x.field, x.value)} />
          </span>
        ))}
        {entries.length > FOLD && <Btn variant="link" onClick={() => setAll(!all)}>{all ? '收起' : `全部 ${entries.length} 项`}</Btn>}
      </div>
      <div className={styles.chips}>
        <Select label="读取类型" value={field} width={120} options={FIELD.map((f) => ({ value: f.value, label: f.label }))} disabled={ro} onChange={(v) => setField(v as AllowField)} />
        <Field
          aria-label="要读取的内容"
          placeholder={FIELD.find((f) => f.value === field)?.hint}
          value={value}
          disabled={ro}
          onChange={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Btn disabled={ro || !value.trim()} onClick={add}>
          添加
        </Btn>
      </div>
    </Slab>
  );
}
