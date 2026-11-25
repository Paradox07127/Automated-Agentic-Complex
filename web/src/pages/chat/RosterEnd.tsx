import { navigate } from '../../shell/nav';
import { Btn, Empty, ErrBar } from '../../ui';

/** The end state with no character to show topics of: why, and the ways out (read again, import one). */
export function RosterEnd({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  const toImport = () => navigate({ page: 'character', pane: 'import' });
  if (failed) return <ErrBar message="读取角色列表失败：后台服务未响应" onRetry={onRetry} extra={<Btn size="sm" variant="ghost" onClick={toImport}>前往角色页导入</Btn>} />;
  return (
    <Empty
      icon="send"
      title="尚无可用角色"
      action={
        <>
          <Btn variant="primary" onClick={toImport}>前往角色页导入</Btn>
          <Btn variant="ghost" icon="refresh" onClick={onRetry}>重试</Btn>
        </>
      }
    />
  );
}
