import type { QueryClient } from '@tanstack/react-query';
import type { SettingsChange, Unsubscribe } from '../bridge/protocol';

/** The privacy rows, and the menu's pause and exclude: what agentd lets the pages read follows them. */
const ACCESS_SETTINGS = new Set(['wintext', 'grain', 'web', 'typing', 'actions', 'agent_sessions', 'shot', 'keys', 'mask', 'pause', 'exclude']);

/** Once a consent or privacy setting changes, drops every cached read agentd filters by it; open pages read again. */
export function resetOnAccessChange(client: QueryClient, onChange: (cb: (c: SettingsChange) => void) => Unsubscribe): Unsubscribe {
  return onChange(({ ids }) => {
    if (!ids.some((id) => ACCESS_SETTINGS.has(id))) return;
    for (const queryKey of [['today'], ['overview'], ['memory'], ['observe'], ['brief'], ['pipeline']]) void client.resetQueries({ queryKey });
  });
}
