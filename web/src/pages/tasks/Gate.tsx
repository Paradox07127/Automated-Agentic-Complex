import { SlotsOff } from '../../shell/headerSlot';
import { navigate } from '../../shell/nav';
import { usePlugins } from '../../shell/plugins';
import { PowerState } from '../../ui/game';
import { TasksPage } from './Page';

/** The tasks route: with 派发任务和定时任务 off the page stays on screen, greyed and inert, under a board that leads to its switch. */
export function TasksGate() {
  if (usePlugins().personal_agent) return <TasksPage />;
  return (
    <PowerState state="off" mode="page" title="派发任务和定时任务" reason="设置里关掉了「派发任务和定时任务」，角色不接新任务，定时任务也不跑。" action={{ label: '前往设置打开', onClick: () => navigate({ page: 'settings', group: 'perm', item: 'plugins.personal_agent' }) }}>
      <SlotsOff>
        <TasksPage />
      </SlotsOff>
    </PowerState>
  );
}
