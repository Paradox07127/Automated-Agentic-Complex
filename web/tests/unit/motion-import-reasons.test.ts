import { describe, expect, it } from 'vitest';
import { motionImportReason, NO_REASON } from '../../src/features/character/labels';

describe('motionImportReason zip and edit codes', () => {
  it('words bad_zip', () => {
    expect(motionImportReason('bad_zip', undefined)).toBe('压缩包无法读取或存在路径安全风险');
  });

  it('words the motion edit refusals linked_motion and outside_package, not the host fallback', () => {
    for (const code of ['linked_motion', 'outside_package']) expect(motionImportReason(code, undefined)).not.toBe(NO_REASON);
  });
});
