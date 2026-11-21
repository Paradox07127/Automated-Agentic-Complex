import unittest
from pathlib import Path
import validate

EXAMPLES = Path(__file__).resolve().parent / 'examples'


def errors_of(path, session):
    return validate.check_lines(path.read_bytes(), validate.direction_of(path), session=session)


class MotionMediaContractTests(unittest.TestCase):
    def test_valid_sessions_pass(self):
        for name in ['companion-to-avatar-motion-media', 'avatar-to-companion-motion-media']:
            with self.subTest(name):
                self.assertEqual(errors_of(EXAMPLES / f'{name}.ndjson', True), [])

    def test_invalid_examples_fail_on_their_rule(self):
        cases = {'c2a-play-action-loop-not-bool': 'loop', 'c2a-stop-action-without-capability': 'action_loop',
                 'a2c-actions-media-not-bool': 'media', 'a2c-actions-media-without-capability': 'motion_media'}
        for name, word in cases.items():
            with self.subTest(name):
                errors = errors_of(EXAMPLES / 'invalid' / f'{name}.ndjson', False)
                self.assertTrue(any(word in e for e in errors), errors)

    def test_stop_action_carries_only_a_short_play_id(self):
        m = dict(v=1, type='stop_action', play_id='p-1')
        self.assertEqual(validate.check_message(m, 'c2a'), [])
        for patch in [dict(play_id=''), dict(play_id='a' * 65), dict(play_id=1), dict(reason='x')]:
            self.assertTrue(validate.check_message(dict(m, **patch), 'c2a'))

    def test_media_has_exactly_three_booleans(self):
        item = dict(id='a', name='a', section='react', duration=1, trigger='t', required_reason=None, missing=None)
        self.assertEqual(validate.check_action_item(dict(item, media=dict(bgm=True, face=False, camera=False)), 0), [])
        for media in [None, [], dict(bgm=True, face=False), dict(bgm=True, face=False, camera=False, extra=True), dict(bgm=1, face=False, camera=False)]:
            self.assertTrue(validate.check_action_item(dict(item, media=media), 0))


if __name__ == '__main__':
    unittest.main()
