import { TasksLoadError } from '../../data/tasksBase';
import { navigate } from '../../shell/nav';
import { Btn, ErrBar, InfoTip } from '../../ui';
import styles from './Chat.module.css';

export function ChatReadBanner({ errors, disconnected, readAt, onRetry }: { errors: Array<Error | null>; disconnected: boolean; readAt: number; onRetry: () => void }) {
  const failure = errors.find((e): e is Error => e != null);
  const load = failure instanceof TasksLoadError ? failure : null;
  if (disconnected || load?.kind === 'disconnected') return (
    <div className={styles.banner}>
      <ErrBar message="后台服务已断开：对话和任务显示上次读到的数据" staleAt={readAt || undefined} onRetry={onRetry}
        extra={<Btn variant="text" size="sm" onClick={() => navigate({ page: 'diag', item: 'agentd', focus: 'proc-agentd' })}>查看诊断 →</Btn>} />
    </div>
  );
  if (!failure) return null;
  return (
    <div className={styles.banner}>
      <ErrBar message={load?.message ?? '对话记录读取失败'} staleAt={readAt} onRetry={onRetry} extra={load?.code ? <InfoTip label="错误码">{`错误码：${load.code}`}</InfoTip> : undefined} />
    </div>
  );
}
