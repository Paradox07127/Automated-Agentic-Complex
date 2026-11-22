import unittest
from pathlib import Path
import validate

PENDING = Path(__file__).resolve().parent / 'examples' / 'pending'


def errors_of(path, session):
    return validate.check_lines(path.read_bytes(), validate.direction_of(path), session=session)


class MotionStateContractTests(unittest.TestCase):
    STATE = dict(v=1, type='motion_state', behavior_id='b-e7-1', origin='agent', phase='started', resting=True,
                 busy=False, clip='idle_stand_a')

    def test_valid_sessions_pass(self):
        for name in ['avatar-to-companion-motion-state', 'avatar-to-companion-cancel-reasons',
                     'avatar-to-companion-motion-state-user']:
            with self.subTest(name):
                self.assertEqual(errors_of(PENDING / f'{name}.ndjson', True), [])

    def test_the_sessions_carry_the_new_reasons(self):
        text = (PENDING / 'avatar-to-companion-cancel-reasons.ndjson').read_text(encoding='utf-8')
        self.assertIn('"reason":"user_click"', text)
        self.assertIn('"reason":"give_way"', text)
        text = (PENDING / 'avatar-to-companion-motion-state-user.ndjson').read_text(encoding='utf-8')
        self.assertIn('"reason":"user_play"', text)
        self.assertIn('"origin":"user"', text)

    def test_invalid_examples_fail_on_their_rule(self):
        cases = {'a2c-motion-state-bad-phase': 'phase', 'a2c-motion-state-agent-without-behavior': 'behavior_id',
                 'a2c-motion-state-user-with-behavior': 'behavior_id'}
        for name, word in cases.items():
            with self.subTest(name):
                errors = errors_of(PENDING / 'invalid' / f'{name}.ndjson', False)
                self.assertTrue(errors and all(word in e for e in errors), errors)

    def test_a_motion_state_follows_the_contract(self):
        self.assertEqual(validate.check_message(self.STATE, 'a2c'), [])
        for phase in ('started', 'cycle_end', 'ended', 'expired', 'rejected'):
            self.assertEqual(validate.check_message(dict(self.STATE, phase=phase), 'a2c'), [], phase)
        self.assertEqual(validate.check_message(dict(self.STATE, behavior_id=None, origin='local'), 'a2c'), [])
        self.assertEqual(validate.check_message(dict(self.STATE, origin='local'), 'a2c'), [])
        for phase in ('started', 'ended', 'expired', 'rejected'):
            user = dict(self.STATE, behavior_id=None, origin='user', phase=phase)
            self.assertEqual(validate.check_message(user, 'a2c'), [], phase)
        self.assertTrue(validate.check_message(dict(user, phase='cycle_end'), 'a2c'))
        self.assertEqual(validate.check_message(dict(self.STATE, clip='a' * 64), 'a2c'), [])
        for patch in [dict(behavior_id=None), dict(behavior_id=''), dict(behavior_id='a' * 65), dict(behavior_id=3),
                      dict(origin='user'), dict(origin='remote'), dict(origin=None), dict(phase='running'), dict(phase=None),
                      dict(resting=1), dict(resting=None), dict(busy='no'), dict(clip=''), dict(clip='a' * 65),
                      dict(clip=None)]:
            with self.subTest(patch=patch):
                self.assertTrue(validate.check_message(dict(self.STATE, **patch), 'a2c'))
        for key in ('behavior_id', 'origin', 'phase', 'resting', 'busy', 'clip'):
            with self.subTest(missing=key):
                self.assertTrue(validate.check_message({k: v for k, v in self.STATE.items() if k != key}, 'a2c'))

    def test_only_the_renderer_sends_it(self):
        self.assertTrue(validate.check_message(self.STATE, 'c2a'))


if __name__ == '__main__':
    unittest.main()
