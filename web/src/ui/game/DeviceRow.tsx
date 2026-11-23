import type { HTMLAttributes, ReactNode } from 'react';
import type { VisualStateKey } from '../../domain/states';
import { stateVisual } from '../../domain/status';
import { Btn } from '../Btn';
import { Icon, type IconName } from '../Icon';
import { MicroLabel } from './Marks';
import { ReadTick } from './Readout';
import { StatusLamp } from './StatusLamp';
import styles from './DeviceRow.module.css';

/** 行右端的去处：› 同页切换，↗ 离开本页。 */
export interface DeviceRowGo {
  /** 读屏名称和悬停提示（「去进程」「设置 › 内核」） */
  label: string;
  /** ↗：去别的页面 */
  external?: boolean;
  onClick: () => void;
}

/** 设备行（游戏生产统计行）：深名牌块（图标 + 名字 + 副行 + 竖条）│ 浅格中区（StatusLamp + 一行原因）│ 行内修复按钮 │ 读数块（ReadTick ×1–2）│ › 或 ↗。child 画依赖树线；dim 读数变淡；出错时中区浅红底、名牌竖条变红。整行自己不接点击；其余属性（data-*、aria-*、className、onClick）落在根元素上。 */
export interface DeviceRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  icon: IconName;
  name: string;
  /** 名字下一行（版本、地址、pid） */
  sub?: ReactNode;
  /** 名字后的小标签（DEV） */
  tag?: string;
  /** 状态（domain/status.ts 的键） */
  state: VisualStateKey;
  /** 改写状态词 */
  stateLabel?: string;
  /** 状态后一行原因 */
  why?: ReactNode;
  /** 行内修复按钮（Btn sm） */
  actions?: ReactNode;
  /** 读数块：ReadTick ×1–2；没有时写 `micro` */
  reads?: ReactNode;
  /** 读数块空着时的微型英文 */
  micro?: string;
  go?: DeviceRowGo;
  /** 子行：挂在上一行下面，画依赖树线；mid 表示下面还有兄弟行 */
  child?: 'mid' | 'last';
  /** 读数读不到（上游断开）：读数块变淡 */
  dim?: boolean;
  /** 从别处跳来：黄框闪 1.6 秒 */
  highlight?: boolean;
}

export function DeviceRow({ icon, name, sub, tag, state, stateLabel, why, actions, reads, micro, go, child, dim, highlight, className, ...rest }: DeviceRowProps) {
  const tone = stateVisual(state).tone;
  return (
    <div
      {...rest}
      className={className ? `${styles.row} ${className}` : styles.row}
      data-stub="DeviceRow"
      data-tone={tone}
      data-child={child}
      data-dim={dim || undefined}
      data-hl={highlight || undefined}
    >
      <div className={styles.plate}>
        <span className={styles.glyph} aria-hidden="true">
          <Icon name={icon} size={20} />
        </span>
        <b className={styles.name}>
          {name}
          {tag && <span className={styles.tag}>{tag}</span>}
        </b>
        {sub != null && <small className={styles.sub}>{sub}</small>}
        <i className={styles.bar} aria-hidden="true" />
      </div>
      <div className={styles.mid}>
        <StatusLamp state={state} label={stateLabel} />
        {why != null && <span className={styles.why}>{why}</span>}
      </div>
      <div className={styles.acts}>{actions}</div>
      <div className={styles.reads}>{reads ?? (micro && <MicroLabel>{micro}</MicroLabel>)}</div>
      <div className={styles.goCell}>
        {go && (
          <button type="button" className={styles.go} aria-label={go.label} title={go.label} onClick={go.onClick}>
            <Icon name={go.external ? 'ext' : 'chev'} size={go.external ? 14 : 12} />
          </button>
        )}
      </div>
    </div>
  );
}

const noop = () => undefined;

export const DeviceRowDemos: Array<{ name: string; props: DeviceRowProps }> = [
  {
    name: 'ok',
    props: {
      icon: 'hub', name: '后台服务', sub: 'agentd │ 运行 3 小时', state: 'ok', stateLabel: '运行中', why: '连接正常',
      reads: (
        <>
          <ReadTick value="3.2" unit="%" label="CPU" />
          <ReadTick value="412" unit="MB" label="内存" tone="ink" />
        </>
      ),
      go: { label: '去进程', onClick: noop },
    },
  },
  {
    name: 'failed',
    props: {
      icon: 'voice', name: '语音', sub: '127.0.0.1:9880', state: 'broken', stateLabel: '连不上', why: '最后一次 14:20 超时',
      actions: <Btn size="sm" variant="secondary" onClick={noop}>重新连接</Btn>, micro: 'VOICE LINK', child: 'last',
      go: { label: '设置 › 说话', external: true, onClick: noop },
    },
  },
  { name: 'dim', props: { icon: 'kernel', name: '角色内核', sub: 'pi', state: 'idle', stateLabel: '读不到', why: '后台断开', reads: <ReadTick value="—" label="可用能力" />, child: 'mid', dim: true } },
  { name: 'warning', props: { icon: 'radio', name: '主动发言', state: 'warning', stateLabel: '注意', why: '今天挡下 4 次', reads: <ReadTick value="6" unit="/8" label="今天" tone="warn" />, go: { label: '去状态', onClick: noop } } },
];
