import json
import unittest
from pathlib import Path
import validate

EXAMPLES = Path(__file__).resolve().parent / 'examples'
C2A_HELLO = dict(v=1, type='hello', role='companion', pid=4243, protocol=1,
                 capabilities=['capsules_global', 'watchdog', 'actions', 'mod_settings'], build=dict(git='9e3c2555'))
A2C_HELLO = dict(v=1, type='hello', role='avatar', pid=4242, protocol=1, character='birch',
                 capabilities=['heartbeat', 'ack', 'actions', 'mod_settings'], build=dict(git='9e3c2555', renderer='metal'))
SET = dict(v=1, type='set_mod_settings', req=7, character='birch', appearance='mod_1a2b3c4d',
           values={'coat': 1, 'color_v2': 255})
REPLY = dict(v=1, type='mod_settings', req=7, character='birch', appearance='mod_1a2b3c4d',
             values={'coat': 1, 'color_v2': 255})


def session(direction, *messages):
    return validate.check_lines(b''.join(json.dumps(m, ensure_ascii=False).encode() + b'\n' for m in messages), direction, session=True)


def errors_of(path, session):
    return validate.check_lines(path.read_bytes(), validate.direction_of(path), session=session)


class ModSettingsContractTests(unittest.TestCase):
    def test_valid_companion_session(self):
        self.assertEqual(session('c2a', C2A_HELLO, SET, dict(SET, req=8, values={}),
                                 dict(SET, req=9, appearance='default', values={'a' + 'b' * 31: 0}),
                                 dict(v=1, type='set_character', id='aster', appearance='mod_1a2b3c4d',
                                      mod_settings={'mod_1a2b3c4d': {'coat': 0}, 'default': {}})), [])

    def test_valid_avatar_session(self):
        self.assertEqual(session('a2c', A2C_HELLO, dict(v=1, type='ack', req=7, ok=True), REPLY,
                                 dict(REPLY, req=None),
                                 dict(REPLY, req=8, values={'coat': 0, 'color_v2': 2},
                                      adjusted=[dict(id='coat', reason='defaulted'), dict(id='color_v2', reason='unsupported')]),
                                 dict(v=1, type='ack', req=9, ok=False, error='busy')), [])

    def test_hello_lists_up_to_64_capabilities(self):
        caps = [f'cap_{i}' for i in range(64)]
        self.assertEqual(validate.check_message(dict(C2A_HELLO, capabilities=caps), 'c2a'), [])
        self.assertTrue(validate.check_message(dict(C2A_HELLO, capabilities=caps + ['cap_64']), 'c2a'))

    def test_bad_set_mod_settings_is_rejected(self):
        many = {f's{i}': 0 for i in range(65)}
        bad = {
            'missing req': {k: v for k, v in SET.items() if k != 'req'},
            'zero req': dict(SET, req=0),
            'missing character': {k: v for k, v in SET.items() if k != 'character'},
            'empty appearance': dict(SET, appearance=''),
            'long appearance': dict(SET, appearance='a' * 65),
            'missing values': {k: v for k, v in SET.items() if k != 'values'},
            'values not object': dict(SET, values=['coat']),
            'uppercase id': dict(SET, values={'Coat': 0}),
            'id with dot': dict(SET, values={'color.v2': 0}),
            'id starting with a digit': dict(SET, values={'1coat': 0}),
            'id of 33 bytes': dict(SET, values={'a' * 33: 0}),
            'value a string': dict(SET, values={'coat': 'off'}),
            'value a bool': dict(SET, values={'coat': True}),
            'value fractional': dict(SET, values={'coat': 1.5}),
            'value 256': dict(SET, values={'coat': 256}),
            'value negative': dict(SET, values={'coat': -1}),
            '65 switches': dict(SET, values=many),
        }
        for name, m in bad.items():
            with self.subTest(name):
                self.assertTrue(session('c2a', C2A_HELLO, m))

    def test_bad_mod_settings_reply_is_rejected(self):
        bad = {
            'missing req': {k: v for k, v in REPLY.items() if k != 'req'},
            'missing values': {k: v for k, v in REPLY.items() if k != 'values'},
            'bad id': dict(REPLY, values={'coat!': 0}),
            'value a string': dict(REPLY, values={'coat': 'off'}),
            'adjusted not list': dict(REPLY, adjusted={'coat': 'defaulted'}),
            'adjusted bad reason': dict(REPLY, adjusted=[dict(id='coat', reason='nope')]),
            'adjusted bad id': dict(REPLY, adjusted=[dict(id='Coat', reason='defaulted')]),
        }
        for name, m in bad.items():
            with self.subTest(name):
                self.assertTrue(session('a2c', A2C_HELLO, m))

    def test_capability_is_needed(self):
        c2a_hello = dict(C2A_HELLO, capabilities=['actions'])
        a2c_hello = dict(A2C_HELLO, capabilities=['ack'])
        cases = {
            'set_mod_settings': session('c2a', c2a_hello, SET),
            'set_character.mod_settings': session('c2a', c2a_hello, dict(v=1, type='set_character', id='aster',
                                                                         mod_settings={'default': {}})),
            'mod_settings': session('a2c', a2c_hello, REPLY),
        }
        for name, errors in cases.items():
            with self.subTest(name):
                self.assertTrue(any('mod_settings' in e for e in errors), errors)

    def test_bad_set_character_mod_settings_is_rejected(self):
        base = dict(v=1, type='set_character', id='aster')
        for name, value in {'not object': [], 'empty appearance': {'': {}}, 'values not object': {'default': 'coat'},
                            'bad switch': {'default': {'COAT': 0}}, 'value 256': {'default': {'coat': 256}},
                            '65 switches': {'default': {f's{i}': 0 for i in range(65)}}}.items():
            with self.subTest(name):
                self.assertTrue(session('c2a', C2A_HELLO, dict(base, mod_settings=value)))

    def test_whole_line_is_at_most_65536_bytes(self):
        values = {f's{i:02d}' + 's' * 29: 255 for i in range(64)}
        appearances = {f'look{i}': values for i in range(40)}
        errors = session('c2a', C2A_HELLO, dict(v=1, type='set_character', id='aster', mod_settings=appearances))
        self.assertTrue(any('longer than 65536' in e for e in errors), errors)

    def test_startup_argument(self):
        self.assertEqual(validate.check_mod_settings_arg('{"mod_1a2b3c4d":{"coat":1},"default":{}}'), [])
        for name, text in {'not json': '{coat=off}', 'not object': '[]', 'bad id': '{"default":{"Coat":1}}',
                           'value a string': '{"default":{"coat":"off"}}', 'value 256': '{"default":{"coat":256}}', 'nan': '{"default":NaN}',
                           'too long': json.dumps({f'look{i}': {f's{j:02d}' + 's' * 29: 255 for j in range(64)} for i in range(40)})}.items():
            with self.subTest(name):
                self.assertTrue(validate.check_mod_settings_arg(text))

    def test_examples(self):
        for path in [EXAMPLES / 'companion-to-avatar-v27-mod.ndjson', EXAMPLES / 'avatar-to-companion-v27-mod.ndjson']:
            with self.subTest(path.name):
                self.assertEqual(errors_of(path, True), [])
        invalid = sorted((EXAMPLES / 'invalid').glob('a2c-mod-settings-*.ndjson'))
        invalid += sorted((EXAMPLES / 'invalid').glob('c2a-set-mod-settings-*.ndjson'))
        invalid += sorted((EXAMPLES / 'invalid').glob('c2a-set-character-mod-settings-*.ndjson'))
        self.assertEqual(len(invalid), 13)
        for path in invalid:
            with self.subTest(path.name):
                self.assertTrue(errors_of(path, False))


if __name__ == '__main__':
    unittest.main()
