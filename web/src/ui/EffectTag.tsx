import styles from './EffectTag.module.css';

/** 生效标签：「⟳后台」「⟳角色」平时是灰底直角签；pending 时换黄块并写「重启后生效」。 */
export interface EffectTagProps {
  /** 生效需要重启的对象 */
  target: 'backend' | 'character';
  /** 已保存未生效 */
  pending?: boolean;
}

export function EffectTag({ target, pending }: EffectTagProps) {
  const who = target === 'backend' ? '后台' : '角色';
  return (
    <span
      className={styles.tag}
      data-stub="EffectTag"
      data-target={target}
      data-pending={pending || undefined}
      title={pending ? `已保存，重启${who}后生效` : `修改后须重启${who}生效`}
    >
      <span aria-hidden="true">⟳</span>
      {who}
      {pending && <span className={styles.pending}>│ 重启后生效</span>}
    </span>
  );
}

export const EffectTagDemos: Array<{ name: string; props: EffectTagProps }> = [
  { name: 'backend', props: { target: 'backend' } },
  { name: 'character', props: { target: 'character' } },
  { name: 'pending', props: { target: 'character', pending: true } },
  { name: 'pending-backend', props: { target: 'backend', pending: true } },
];
