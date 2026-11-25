import { SlotsOff } from '../../shell/headerSlot';
import { navigate } from '../../shell/nav';
import { usePlugins } from '../../shell/plugins';
import { PowerState } from '../../ui/game';
import { OverviewPage } from './Page';

/** The briefing route: with 每日简报 off the page stays on screen, greyed and inert, under a board that leads to its switch. */
export function OverviewGate() {
  if (usePlugins().daily_brief) return <OverviewPage />;
  return (
    <PowerState state="off" mode="page" title="每日简报" reason="已在设置中关闭「每日简报」，将不汇总当日工作摘要与生成新的工作记录。" action={{ label: '前往开启', onClick: () => navigate({ page: 'settings', group: 'privacy', item: 'plugins.daily_brief' }) }}>
      <SlotsOff>
        <OverviewPage />
      </SlotsOff>
    </PowerState>
  );
}
