import { describe, expect, it } from 'vitest';
import { motionImportReason } from '../../src/pages/character/labels';

describe('motionImportReason zip codes', () => {
  it('words bad_zip', () => {
    expect(motionImportReason('bad_zip', undefined)).toBe('压缩包打不开或不安全');
  });

  it('words ambiguous_motion', () => {
    expect(motionImportReason('ambiguous_motion', undefined)).toBe('包里有多支动作、相机或音乐，分不出用哪个');
  });
});
