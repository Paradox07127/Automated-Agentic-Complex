// 明细：开着的项一行一个（星标、名牌、每小时走势、今天和对比值），关着的项在列表下合成一行，底部排序和对比两个下拉。
import { useState } from 'react';
import { appNow } from '../../bridge/clock';
import { Btn, IconBtn, Select } from '../../ui';
import { ITEM_ORDER, ITEMS, SWITCH_LABEL, type BriefItem, type BriefItemId, type BriefSwitch } from './briefDay';
import type { BriefTabProps } from './briefTabs';
import { useGo } from './nav';
import styles from './DetailTab.module.css';

type Sort = 'def' | 'up' | 'down';
type Cmp = 'avg' | 'y';

/** 设置页里管这个开关的分组；插件开关带着它的行。 */
const SWITCH_AT: Record<BriefSwitch, { group: string; item?: string }> = {
  scr: { group: 'privacy', item: 'plugins.screen_awareness' },
  read: { group: 'privacy' },
  shot: { group: 'privacy' },
  code: { group: 'privacy' },
  agent: { group: 'kernel', item: 'plugins.harness_bridge' },
  voice: { group: 'speak' },
};

const W = 240;
const H = 50;

function plain(id: BriefItemId, v: number): string {
  const { kind, unit } = ITEMS[id];
  if (kind === 'usd') return `$${v.toFixed(2)}`;
  if (kind === 'min' || kind === 'sec') {
    const n = Math.round(v);
    const [big, small] = kind === 'min' ? ['h', 'm'] : ['m', 's'];
    const hi = Math.floor(n / 60);
    const lo = n % 60;
    return hi === 0 ? `${lo} ${small}` : lo === 0 ? `${hi} ${big}` : `${hi} ${big} ${lo} ${small}`;
  }
  // 近 7 天均值可以带小数。
  return `${Number.isInteger(v) ? v : v.toFixed(1)}${unit ? ` ${unit}` : ''}`;
}

function Trend({ id, item, lim }: { id: BriefItemId; item: BriefItem; lim: number }) {
  if (item.hours == null) return <span className={styles.total}>{plain(id, item.today)}</span>;
  const hrs = item.hours;
  // 分钟按小时计，一小时最多 60。
  const mx = ITEMS[id].kind === 'min' ? 60 : Math.max(...hrs, 1);
  const px = (h: number) => (h / 24) * W;
  const py = (v: number) => H - 2 - ((H - 6) * v) / mx;
  let d = '';
  for (let h = 0; h < Math.ceil(lim); h++) d += `${h ? 'L' : 'M'}${px(h).toFixed(1)} ${py(hrs[h] ?? 0).toFixed(1)}L${px(Math.min(h + 1, lim)).toFixed(1)} ${py(hrs[h] ?? 0).toFixed(1)}`;
  const ex = px(lim).toFixed(1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${d}L${ex} ${H}L0 ${H}Z`} className={styles.area} />
      <path d={d} className={styles.line} />
      {lim < 24 && <line x1={ex} x2={ex} y1={0} y2={H} className={styles.now} />}
    </svg>
  );
}

export function DetailTab({ day, pins, onPins }: BriefTabProps) {
  const go = useGo();
  const [sort, setSort] = useState<Sort>('def');
  const [cmp, setCmp] = useState<Cmp>('avg');
  const now = new Date(appNow());
  // 今天只画到现在这一刻，单位小时。
  const lim = day.partial ? now.getHours() + now.getMinutes() / 60 : 24;
  const full = pins.length >= 6;

  const refOf = (id: BriefItemId) => (cmp === 'avg' ? day.items[id].avg7 : day.items[id].yesterday);
  const rows = ITEM_ORDER.filter((id) => day.items[id].enabled);
  if (sort !== 'def') {
    // 对比值为 0 时按差值排；没有对比值的排最后。
    const ratio = (id: BriefItemId) => {
      const ref = refOf(id);
      return ref == null ? null : (day.items[id].today - ref) / (ref || 1);
    };
    rows.sort((a, b) => {
      const ra = ratio(a);
      const rb = ratio(b);
      if (ra == null || rb == null) return (ra == null ? 1 : 0) - (rb == null ? 1 : 0);
      return sort === 'up' ? rb - ra : ra - rb;
    });
  }

  const off = ITEM_ORDER.filter((id) => !day.items[id].enabled);
  const offSwitches = (Object.keys(SWITCH_LABEL) as BriefSwitch[]).filter((s) => !day.switches[s] && off.some((id) => ITEMS[id].need.includes(s)));

  const toggle = (id: BriefItemId) => {
    if (pins.includes(id)) onPins(pins.filter((p) => p !== id));
    else if (!full) onPins([...pins, id]);
  };

  return (
    <div className={styles.dt}>
      <div className={styles.head} aria-hidden="true">
        <span>项目</span>
        <span>每小时走势</span>
        <span>今天 │ {cmp === 'avg' ? '均值' : '昨天'}</span>
      </div>
      <ul className={styles.list} aria-label="明细">
        {rows.map((id) => {
          const it = day.items[id];
          const meta = ITEMS[id];
          const pinned = pins.includes(id);
          const ref = refOf(id);
          return (
            <li key={id} className={styles.it} data-pinned={pinned || undefined}>
              <div className={styles.nm}>
                <span className={styles.star}>
                  <IconBtn
                    icon="pin"
                    shape="round"
                    pressed={pinned}
                    disabled={!pinned && full}
                    disabledReason="总览最多放 6 项，先拿掉一项"
                    label={`${pinned ? '从总览拿掉' : '放进总览'}：${meta.name}`}
                    onClick={() => toggle(id)}
                  />
                </span>
                <span className={styles.t}>
                  <span className={styles.name}>{meta.name}</span>
                  <small>{meta.src}</small>
                </span>
                <span className={styles.bar} aria-hidden="true" />
              </div>
              <div className={styles.well} role="img" aria-label={`${meta.name}每小时走势`}>
                <Trend id={id} item={it} lim={lim} />
              </div>
              <div className={styles.vals}>
                <b className="num">{plain(id, it.today)}</b>
                <span className="num">
                  {cmp === 'avg' ? '均值' : '昨天'} {ref == null ? '—' : plain(id, ref)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {offSwitches.length > 0 && (
        <div className={styles.off}>
          <span>
            另有 <b className="num">{off.length}</b> 项没记，因为这些开关关着：{offSwitches.map((s) => SWITCH_LABEL[s]).join('、')}
          </span>
          <Btn variant="text" size="sm" onClick={() => go({ page: 'settings', ...SWITCH_AT[offSwitches[0]!] })}>
            前往设置
          </Btn>
        </div>
      )}
      <div className={styles.foot}>
        <span className={styles.sel}>
          <span aria-hidden="true">排序</span>
          <Select
            label="排序"
            width={140}
            value={sort}
            options={[
              { value: 'def', label: '默认' },
              { value: 'up', label: '比平时多' },
              { value: 'down', label: '比平时少' },
            ]}
            onChange={(v) => setSort(v as Sort)}
          />
        </span>
        <span className={styles.sel}>
          <span aria-hidden="true">对比</span>
          <Select
            label="对比"
            width={140}
            value={cmp}
            options={[
              { value: 'avg', label: '近 7 天均值' },
              { value: 'y', label: '昨天' },
            ]}
            onChange={(v) => setCmp(v as Cmp)}
          />
        </span>
      </div>
    </div>
  );
}
