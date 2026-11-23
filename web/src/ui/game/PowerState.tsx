import { useId, type ReactNode } from 'react';
import { Btn } from '../Btn';
import styles from './PowerState.module.css';

/**
 * 通电状态（游戏 BuildingStateStopped / NoPower / NotLinked）：能力关着或服务没连上时，页面和区块不藏，灰掉并说明，按钮跳到设置里那一行。
 * 已关闭是中灰 ⊗ 加灰斜纹，未接入是橙红拔开的插头，连接环和连线呼吸。
 */
export interface PowerStateProps {
  /** off 已关闭（设置里关掉的能力）；unlinked 未接入（能力开着，服务没连上） */
  state: 'off' | 'unlinked';
  /** page 盖在整页上，内容灰掉、不能操作；block 区块顶部一条状态条，内容灰掉但照常可用 */
  mode: 'page' | 'block';
  /** 能力或服务的名字 */
  title: string;
  /** 一句原因 */
  reason: ReactNode;
  /** 按钮文字和点了做什么（通常跳到设置里那一行，深链要带分组） */
  action: { label: string; onClick: () => void };
  /** 按钮旁的别的操作（重新检测） */
  more?: ReactNode;
  /** 照常渲染的内容 */
  children: ReactNode;
}

const WORD = { off: '已关闭', unlinked: '未接入' } as const;
const MICRO = { off: 'STATE CLOSED', unlinked: 'POWER NOT LINKED' } as const;

/** icon_ui_power_pole_machine_state_4：缺两段的环里一个 ×。 */
function OffGlyph({ size }: { size: number }) {
  return (
    <svg className={styles.glyph} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-shape="off">
      <circle cx="12" cy="12" r="9.6" fill="none" stroke="currentColor" strokeWidth="2.6" pathLength="100" strokeDasharray="38 12" transform="rotate(-80 12 12)" />
      <path d="M6.8 6.8l3.8 3.8M17.2 6.8l-3.8 3.8M6.8 17.2l3.8-3.8M17.2 17.2l-3.8-3.8" stroke="currentColor" strokeWidth="2.8" />
    </svg>
  );
}

/** icon_ui_power_pole_machine_state_1：插头和插座分开，中间的插脚是呼吸的连线。 */
function PlugGlyph({ size }: { size: number }) {
  return (
    <svg className={styles.glyph} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" data-shape="plug">
      <path d="M0 14.6h6v2.8H0zM13 9v14h-1.5a7 7 0 0 1 0-14z" fill="currentColor" />
      <path className={styles.link} d="M16 11.5h3.5v2.6H16zM16 17.9h3.5v2.6H16z" fill="currentColor" />
      <path d="M19.5 9H21a7 7 0 0 1 0 14h-1.5zM26 14.6h6v2.8h-6z" fill="currentColor" />
    </svg>
  );
}

const glyph = (state: PowerStateProps['state'], size: number) => (state === 'off' ? <OffGlyph size={size} /> : <PlugGlyph size={size} />);

/** 色块状态词 + α0.6 的箭头尾，深色字。 */
function Word({ state }: { state: PowerStateProps['state'] }) {
  return (
    <span className={styles.word}>
      <b>{WORD[state]}</b>
      <i className={styles.tail} aria-hidden="true" />
    </span>
  );
}

export function PowerState({ state, mode, title, reason, action, more, children }: PowerStateProps) {
  const id = useId();
  const go = (
    <Btn variant="ghost" size={mode === 'page' ? 'md' : 'sm'} go onClick={action.onClick}>
      {action.label}
    </Btn>
  );
  if (mode === 'block')
    return (
      <div className={styles.block} data-stub="PowerState" data-state={state} data-mode="block">
        <div className={styles.strip} role="status" aria-labelledby={id}>
          <span className={styles.mark}>{glyph(state, 20)}</span>
          <Word state={state} />
          <span className={styles.text}>
            <b id={id}>{title}</b>
            <span className={styles.why}>{reason}</span>
          </span>
          <span className={styles.acts}>
            {more}
            {go}
          </span>
        </div>
        <div className={styles.content} data-dim="">
          {children}
        </div>
      </div>
    );
  return (
    <div className={styles.page} data-stub="PowerState" data-state={state} data-mode="page">
      <div className={styles.content} data-dim="" inert>
        {children}
      </div>
      <div className={styles.veil}>
        <div className={styles.board} role="status" aria-labelledby={id} data-depth="">
          <span className={styles.plate}>
            <i className={styles.halo} aria-hidden="true" />
            <i className={styles.halo} aria-hidden="true" />
            {glyph(state, 48)}
          </span>
          <div className={styles.body}>
            <span className={styles.head}>
              <Word state={state} />
              <span className={styles.micro} aria-hidden="true">
                {MICRO[state]}
              </span>
            </span>
            <h2 id={id} className={styles.title}>
              {title}
            </h2>
            <p className={styles.reason}>{reason}</p>
            <span className={styles.acts}>
              {more}
              {go}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

const THREAD = (
  <div style={{ display: 'grid', alignContent: 'start', gap: 12, height: 360, padding: 16, background: 'var(--ef-raised)' }}>
    <p>帮我整理这周的提交，出一份周报。</p>
    <p>好，我先看这周的提交记录，再按目录归到项目里。</p>
    <p>按项目分组，不要按日期。</p>
  </div>
);

const INPUT = (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 8, background: 'var(--ef-raised)' }}>
    <span style={{ flex: 1, padding: '10px 16px', borderRadius: 21, background: 'var(--ef-field)', color: 'var(--ef-paper-text-2)' }}>输入消息…</span>
    <Btn variant="secondary">发送</Btn>
  </div>
);

export const PowerStateDemos: Array<{ name: string; props: PowerStateProps }> = [
  {
    name: 'off-page',
    props: { state: 'off', mode: 'page', title: '和她对话', reason: '设置里关掉了「和她对话」，她不回消息，也不记新的对话。', action: { label: '前往设置打开', onClick: () => {} }, children: THREAD },
  },
  {
    name: 'unlinked-page',
    props: { state: 'unlinked', mode: 'page', title: '模型账号', reason: '没有可用的模型：登录 Claude Code 或 Codex，或在设置里给 pi 填一个 API key。', action: { label: '前往设置连接', onClick: () => {} }, children: THREAD },
  },
  {
    name: 'off-block',
    props: { state: 'off', mode: 'block', title: '屏幕识读', reason: '隐私设置里关着，不能附加截图', action: { label: '前往设置打开', onClick: () => {} }, children: INPUT },
  },
  {
    name: 'unlinked-block',
    props: {
      state: 'unlinked',
      mode: 'block',
      title: '没有可用的模型',
      reason: '登录 Claude Code 或 Codex，或在设置里给 pi 填一个 API key',
      action: { label: '前往设置连接', onClick: () => {} },
      more: <Btn size="sm" variant="ghost" icon="refresh">重新检测</Btn>,
      children: INPUT,
    },
  },
];
