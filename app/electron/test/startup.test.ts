// Which window the app opens at launch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupWindow } from '../src/common/startup.ts';

test('a config error opens 主页; a first run the guide; no character 角色; otherwise nothing', () => {
  assert.deepEqual(startupWindow({ configError: true, characters: 0, onboardingDone: false }), { open: 'main', route: '/home' });
  assert.deepEqual(startupWindow({ configError: true, characters: 2, onboardingDone: true }), { open: 'main', route: '/home' });
  // The guide comes first; the character page waits until it is done.
  assert.deepEqual(startupWindow({ configError: false, characters: 0, onboardingDone: false }), { open: 'onboarding' });
  assert.deepEqual(startupWindow({ configError: false, characters: 1, onboardingDone: false }), { open: 'onboarding' });
  assert.deepEqual(startupWindow({ configError: false, characters: 0, onboardingDone: true }), { open: 'main', route: '/character' });
  assert.deepEqual(startupWindow({ configError: false, characters: 1, onboardingDone: true }), { open: 'none' });
});
