import { MOTION_HOURS, MOTION_HOURS_SPARSE, STATE_SCALES } from '../../../mock/character';
import { SWITCH_REJECT } from '../../../mock/fixtures';
import { demo } from '../../../pages/character/demoSlot';

Object.assign(demo, { switchReject: SWITCH_REJECT, motionHours: MOTION_HOURS, motionHoursSparse: MOTION_HOURS_SPARSE, stateScales: STATE_SCALES });
