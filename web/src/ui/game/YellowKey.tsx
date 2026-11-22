import { Icon, type IconName } from '../Icon';
import { MicroLabel } from './Marks';
import styles from './YellowKey.module.css';

/** 黄色斜切主键：右上小切角、左下大切角，图标在深色斜切块里，右段细斜纹，外圈黄光；一屏只放一个。竖向款（动作条的方键）左上、右下切角，图标和微型英文在上、字在下。 */
export interface YellowKeyProps {
  /** 字 */
  label: string;
  /** 深色块里的图标，默认 play */
  icon?: IconName;
  /** 字上方的微型英文；竖向款在图标右边 */
  micro?: string;
  /** 竖向款：默认 96 × 76，页面可用 `--yk-w` / `--yk-h` 改 */
  vertical?: boolean;
  /** 禁用：灰底斜纹 */
  disabled?: boolean;
  /** 禁用原因（悬停提示） */
  disabledReason?: string;
  onClick?: () => void;
}

export function YellowKey({ label, icon = 'play', micro, vertical, disabled, disabledReason, onClick }: YellowKeyProps) {
  if (vertical)
    return (
      <button type="button" className={styles.key} data-stub="YellowKey" data-vertical="" disabled={disabled} title={disabled ? disabledReason : undefined} onClick={onClick}>
        <span className={styles.tall}>
          <span className={styles.top}>
            <span className={styles.ki}>
              <Icon name={icon} size={16} />
            </span>
            {micro && <MicroLabel>{micro}</MicroLabel>}
          </span>
          <span className={styles.lbl}>{label}</span>
        </span>
      </button>
    );
  return (
    <button type="button" className={styles.key} data-stub="YellowKey" disabled={disabled} title={disabled ? disabledReason : undefined} onClick={onClick}>
      <span className={styles.face}>
        <span className={styles.ki}>
          <Icon name={icon} size={16} />
        </span>
        <span className={styles.txt}>
          {micro && <MicroLabel>{micro}</MicroLabel>}
          <span>{label}</span>
        </span>
      </span>
    </button>
  );
}

export const YellowKeyDemos: Array<{ name: string; props: YellowKeyProps }> = [
  { name: 'preview', props: { label: '桌面预览', micro: 'Desktop' } },
  { name: 'save', props: { label: '保存', icon: 'check', micro: 'Commit' } },
  { name: 'vertical', props: { label: '连播', micro: 'Setlist', vertical: true } },
  { name: 'disabled', props: { label: '桌面预览', micro: 'Desktop', disabled: true, disabledReason: '桌面角色没有连上' } },
];
