import { SlotsOff } from '../../shell/headerSlot';
import { navigate } from '../../shell/nav';
import { usePlugins } from '../../shell/plugins';
import { PowerState } from '../../ui/game';
import { TasksPage } from './Page';

/** The tasks route: with 派发任务和定时任务 off the page stays on screen, greyed and inert, under a board that leads to its switch. */
export function TasksGate() {
  if (usePlugins().personal_agent) return <TasksPage />;
  return (
    <PowerState state="off" mode="page" title="个人代理与自主能力" reason="已在「设置 › 能力」中关闭「个人代理与自主能力」，角色将不接收新任务且不运行定时任务。" action={{ label: '前往开启', onClick: () => navigate({ page: 'settings', group: 'perm', item: 'plugins.personal_agent' }) }}>
      <SlotsOff>
        <TasksPage />
      </SlotsOff>
    </PowerState>
  );
}
