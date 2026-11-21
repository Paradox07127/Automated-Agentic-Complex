import { OBS_BLOCKED, OBS_PAUSE, OBS_SEGMENTS, OBS_TITLES, obsShots } from '../../../mock/observe';
import { demo } from '../../../pages/observe/demoSlot';

Object.assign(demo, {
  titles: OBS_TITLES,
  b11: { segments: OBS_SEGMENTS, shots: obsShots, blocked: OBS_BLOCKED, pause: OBS_PAUSE },
});
