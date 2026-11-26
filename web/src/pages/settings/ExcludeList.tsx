import { useState } from 'react';
import { Btn, Field, Fold, IconBtn, Select, Switch } from '../../ui';
import { GameSeg } from '../../ui/game';
import { AllowList } from './AllowList';
import { addBlacklist, failure, removeBlacklist, restoreBlacklist, setBlacklistMode } from './api';
import { useSettings } from './ctx';
import { Slab } from './Slab';
import type { BlacklistField, WireBlacklist } from './wire';
import styles from './groups.module.css';

const FIELD: Array<{ value: BlacklistField; label: string; hint: string }> = [
  { value: 'app_names', label: '应用名', hint: '例如 微信' },
  { value: 'bundle_ids', label: '应用 ID', hint: '例如 com.tencent.xinWeChat' },
  { value: 'domains', label: '网站', hint: '例如 mail.qq.com' },
  { value: 'title_patterns', label: '窗口标题', hint: '正则，例如 工资' },
];
const PREFIX: Record<BlacklistField, string> = { app_names: '应用', bundle_ids: '应用', domains: '网站', title_patterns: '标题' };
const MODE: Array<{ value: WireBlacklist['mode']; label: string }> = [
  { value: 'allow', label: '仅允许名单' },
  { value: 'deny', label: '排除名单' },
];
/** Chips shown before the fold; the fold takes the rest only when they are more than 3. */
const FOLD = 8;
const FLAT = 3;

/** 不看的应用和网站: agentd's blacklist; adding can also delete what it already recorded from those windows. */
export function ExcludeList() {
  const { model, ro: groupRo, agentdOff, blacklist, reload } = useSettings();
  const ro = groupRo || agentdOff;
  const [field, setField] = useState<BlacklistField>('app_names');
  const [value, setValue] = useState('');
  const [purge, setPurge] = useState(false);
  const fail = (what: string) => (e: unknown) => model.notify({ message: `${what}：${failure(e).text}`, severity: 'danger', persistent: true });

  const entries = blacklist ? FIELD.flatMap((f) => blacklist[f.value].map((v) => ({ field: f.value, value: v }))) : [];
  const shown = entries.length > FOLD + FLAT ? entries.slice(0, FOLD) : entries;
  const rest = entries.slice(shown.length);
  const add = () => {
    const v = value.trim();
    if (!v) return;
    const send = () =>
      addBlacklist(field, v, purge).then((r) => {
        setValue('');
        reload('blacklist');
        const n = Object.values(r.deleted).reduce((a, b) => a + b, 0);
        model.notify({ message: purge ? `已添加「${v}」，删掉已记下的 ${n} 条，连同相关的活动摘要、工作记录和记忆` : `已添加「${v}」` });
      }, fail(`没能添加「${v}」`));
    if (!purge) return void send();
    model.ask({
      title: `添加「${v}」并删掉已记下的？`,
      danger: true,
      warning: '不能恢复',
      note: '删除从这些窗口记下的活动、上下文、观察记录和操作时间线，连同由它们生成的活动摘要、工作记录和记忆，不能恢复。',
      confirmLabel: '添加并删除',
      onConfirm: send,
    });
  };
  const remove = (f: BlacklistField, v: string) =>
    void removeBlacklist(f, v).then(() => {
      reload('blacklist');
      model.notify({ message: `已移除「${v}」，此后将恢复正常读取` });
    }, fail(`移除「${v}」失败`));
  const restore = () =>
    model.ask({
      title: '恢复默认排除名单？',
      note: '将重新加入系统预设的排除项（密码管理器、即时通讯、银行及支付网站），自定义项保持不变。',
      confirmLabel: '恢复默认',
      onConfirm: () =>
        restoreBlacklist().then((r) => {
          reload('blacklist');
          model.notify({ message: r.added ? `已恢复 ${r.added} 项默认排除项` : '默认排除项已全部存在' });
        }, fail('恢复默认排除名单失败')),
    });
  const setMode = (m: string) =>
    void setBlacklistMode(m as WireBlacklist['mode']).then(() => {
      reload('blacklist');
      model.notify({ message: `已切换为「${MODE.find((x) => x.value === m)?.label}」模式` });
    }, fail('切换名单过滤模式失败'));
  const modeSeg = <GameSeg variant="setting" label="名单过滤模式" value={blacklist?.mode ?? ''} options={MODE} disabled={ro || blacklist == null} onChange={setMode} />;

  const chip = (x: { field: BlacklistField; value: string }) => (
    <span key={`${x.field}:${x.value}`} className={styles.xchip}>
      {PREFIX[x.field]} │ {x.value}
      <IconBtn icon="close" size="sm" label={`移除 ${x.value}`} disabled={ro} onClick={() => remove(x.field, x.value)} />
    </span>
  );

  if (blacklist?.mode === 'allow') return <AllowList right={modeSeg} />;
  return (
    <Slab id="exclude" title="排除的应用与网站" desc={blacklist?.incognito ? '列表内应用与网站及无痕窗口一律不读取、不外发' : '列表内的应用与网站不读取、不外发'} right={modeSeg}>
      <div className={styles.chips}>
        {blacklist == null && <span className={styles.t2}>—</span>}
        {shown.map(chip)}
      </div>
      {rest.length > 0 && (
        <Fold id="exclude-rest" label="其余" count={rest.length} summary={rest.map((x) => x.value).join('、')}>
          <div className={styles.chips}>{rest.map(chip)}</div>
        </Fold>
      )}
      <div className={styles.chips}>
        <Select label="排除类型" value={field} width={120} options={FIELD.map((f) => ({ value: f.value, label: f.label }))} disabled={ro} onChange={(v) => setField(v as BlacklistField)} />
        <Field
          label="要排除的内容"
          placeholder={FIELD.find((f) => f.value === field)?.hint}
          value={value}
          disabled={ro}
          onChange={setValue}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <span className={styles.t2}>顺手删掉已记下的</span>
        <Switch variant="setting" checked={purge} label="顺手删掉已记下的" disabled={ro} onChange={setPurge} />
        <Btn disabled={ro || !value.trim()} onClick={add}>
          添加
        </Btn>
        {!ro && <Btn variant="link" onClick={restore}>恢复默认排除</Btn>}
      </div>
    </Slab>
  );
}
