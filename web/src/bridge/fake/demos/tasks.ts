import { T1 } from '../../../mock/fixtures/ids';
import { CARD_HISTORY } from '../../../mock/tasksBoard';
import { demo } from '../../../pages/tasks/demoSlot';

Object.assign(demo, { history: CARD_HISTORY, decideFailId: T1 });
