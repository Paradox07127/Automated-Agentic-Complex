import { Fragment, useState } from 'react';
import { Btn, OpenSec, Paper, Plate, RowPlate, Seg, Tabs, type BtnProps, type IconName } from '../../ui';
import styles from './Material.module.css';

const STATES = [
  ['默认', ''],
  ['悬停', 'hover'],
  ['按下', 'press'],
  ['禁用', 'disabled'],
  ['焦点', 'focus'],
] as const;

const KINDS: Array<[NonNullable<BtnProps['variant']>, string, string]> = [
  ['primary', '主按钮', '派发任务'],
  ['secondary', '次按钮', '查看诊断'],
  ['danger', '危险', '停止任务'],
  ['text', '文字按钮', '前往设置'],
];

const ROWS: Array<[string, IconName, string, string]> = [
  ['r1', 'file', '整理本周提交周报', '待复核 │ 角色任务'],
  ['r2', 'tool', '修 HostLink 断线', '进行中 │ Claude Code'],
  ['r3', 'user', '周报按项目分组', '推断 │ 待确认'],
];

/** `#/ds?sec=material`: the three panel levels, four buttons in five states, list rows, tabs and segments. */
export function Material() {
  const [row, setRow] = useState('r2');
  const [tab, setTab] = useState('all');
  const [range, setRange] = useState('today');
  return (
    <div className={styles.grid} data-section="material">
      <div className={styles.full}>
        <OpenSec no="01" title="开放区" right={<Btn variant="text" size="sm">查看全部</Btn>}>
          <p className={styles.note}>页面大部分内容属于这一级：只有节标题、细分隔线和留白，不画边框。节间距用 --ef-sec-gap，高度不足 700 时减 25%。</p>
        </OpenSec>
      </div>
      <div className={styles.wide}>
        <Plate no="02" label="板">
          <b>板</b>
          <p className={styles.note}>浅一级底色、1 px 内描边、顶边 1 px 高光（暗色另加 4% 白色线性高光）、右上 8 px 斜切，左上编号签。用于需要聚焦的模块。</p>
          <div className={styles.btnRow}>
            <Btn variant="primary">派发任务</Btn>
            <Btn variant="secondary">查看诊断</Btn>
          </div>
        </Plate>
      </div>
      <div className={styles.narrow}>
        <Paper label="白纸卡">
          <b>白纸卡</b>
          <p className={styles.note}>只给决策：审批、复核、待确认。双圈按钮只用在这里。</p>
          <div className={styles.btnRow}>
            <Btn variant="ring">否认</Btn>
            <Btn variant="primary">确认</Btn>
          </div>
        </Paper>
      </div>
      <div className={styles.full}>
        <OpenSec no="03" title="按钮">
          <div className={styles.states}>
            <span />
            {STATES.map(([label]) => (
              <span key={label} className={styles.cap}>
                {label}
              </span>
            ))}
            {KINDS.map(([variant, name, text]) => (
              <Fragment key={variant}>
                <span className={styles.cap}>{name}</span>
                {STATES.map(([label, force]) => (
                  <span key={label} data-force={force || undefined}>
                    <Btn variant={variant} disabled={force === 'disabled'} disabledReason={force === 'disabled' ? '示例：不可用' : undefined}>
                      {text}
                    </Btn>
                  </span>
                ))}
              </Fragment>
            ))}
            <span className={styles.cap}>小号与图标</span>
            <span>
              <Btn variant="primary" size="sm" tail="chev">
                屏幕识读
              </Btn>
            </span>
            <span>
              <Btn variant="secondary" size="sm" tail="plus">
                快速输入
              </Btn>
            </span>
            <span>
              <Btn variant="primary" size="lg" kbd="⏎">
                确认
              </Btn>
            </span>
          </div>
        </OpenSec>
      </div>
      <div className={styles.half}>
        <OpenSec no="04" title="列表行">
          {ROWS.map(([id, icon, title, meta]) => (
            <RowPlate
              key={id}
              icon={icon}
              title={title}
              meta={meta}
              selected={row === id}
              onClick={() => setRow(id)}
              actions={
                <Btn variant="text" size="sm">
                  查看原文
                </Btn>
              }
            />
          ))}
        </OpenSec>
      </div>
      <div className={styles.half}>
        <OpenSec no="05" title="页签与分段">
          <Tabs
            label="任务视图"
            keys={false}
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'pending', label: '待处理', count: 3 },
              { id: 'all', label: '全部任务' },
              { id: 'goals', label: '目标' },
            ]}
          />
          <div className={styles.tabsKeys}>
            <Tabs label="诊断视图" value="flow" tabs={[{ id: 'flow', label: '流程' }, { id: 'turns', label: '轮次' }, { id: 'res', label: '资源' }]} />
          </div>
          <div className={styles.btnRow}>
            <Seg
              label="范围"
              value={range}
              onChange={setRange}
              options={[
                { value: 'today', label: '今天' },
                { value: '7d', label: '7 天' },
                { value: '30d', label: '30 天' },
              ]}
            />
            <Seg label="来源" size="sm" value="all" options={[{ value: 'all', label: '全部' }, { value: 'role', label: '角色' }, { value: 'off', label: '外部', disabled: true }]} />
          </div>
        </OpenSec>
      </div>
    </div>
  );
}
