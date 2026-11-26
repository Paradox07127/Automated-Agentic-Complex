import { describe, expect, it } from 'vitest';
import { BEHAVIOR as CHARACTER_BEHAVIOR } from '../../src/features/character/labels';
import { BEHAVIOR as DIAG_BEHAVIOR } from '../../src/pages/diag/model';

/** agentd's character/behavior.py ACTIVITIES, in order. */
const ACTIVITIES = ['idle', 'relax', 'fidget', 'think', 'wait', 'react', 'yawn', 'sleep', 'fly', 'guard'];

describe('behavior.ticked labels', () => {
  it('name exactly the activities behavior.py chooses from', () => {
    expect(Object.keys(CHARACTER_BEHAVIOR)).toEqual(ACTIVITIES);
    expect(Object.keys(DIAG_BEHAVIOR)).toEqual(ACTIVITIES);
  });
});
