import { SlotsOff } from '../../shell/headerSlot';
import { navigate } from '../../shell/nav';
import { usePlugins } from '../../shell/plugins';
import { PowerState } from '../../ui/game';
import { OverviewPage } from './Page';

/** The briefing route: with 每日简报 off the page stays on screen, greyed and inert, under a board that leads to its switch. */
export function OverviewGate() {
  if (usePlugins().daily_brief) return <OverviewPage />;
  return (
    <PowerState state="off" mode="page" title="每日简报" reason="设置里关掉了「每日简报」，不汇总今天做了什么，也不记新的工作记录。" action={{ label: '前往设置打开', onClick: () => navigate({ page: 'settings', group: 'privacy', item: 'plugins.daily_brief' }) }}>
      <SlotsOff>
        <OverviewPage />
      </SlotsOff>
    </PowerState>
  );
}
