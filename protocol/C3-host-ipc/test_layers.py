import json
import unittest
import validate

C2A_HELLO = dict(v=1, type='hello', role='companion', pid=4243, protocol=1,
                 capabilities=['capsules_global', 'watchdog', 'pointer', 'pass_through', 'keep_clear', 'layers'], build=dict(git='9e3c2555'))
A2C_HELLO = dict(v=1, type='hello', role='avatar', pid=4242, protocol=1, character='birch',
                 capabilities=['heartbeat', 'ack', 'behavior_receipt', 'motion_requests', 'layers'], build=dict(git='9e3c2555', renderer='metal'),
                 appearance='default',
                 appearances=[dict(id='default', name='默认', kind='original'),
                              dict(id='summer', name='夏装', kind='imported', desc='用户导入的服装')],
                 layers=[dict(id='coat', name='外套'), dict(id='tail', name='尾部装饰', appearances=['default'])],
                 hidden_layers=['tail'])


def session(direction, *messages):
    return validate.check_lines(b''.join(json.dumps(m, ensure_ascii=False).encode() + b'\n' for m in messages), direction, session=True)


class LayersContractTests(unittest.TestCase):
    def test_valid_companion_session(self):
        self.assertEqual(session('c2a', C2A_HELLO,
                                 dict(v=1, type='set_layers', hidden=['coat']),
                                 dict(v=1, type='set_layers', hidden=[]),
                                 dict(v=1, type='set_character', id='aster', hidden_layers=['coat'])), [])

    def test_valid_avatar_session(self):
        self.assertEqual(session('a2c', A2C_HELLO,
                                 dict(v=1, type='layers_changed', hidden=['coat']),
                                 dict(v=1, type='layers_change_failed', hidden=['coat'], reason='superseded')), [])

    def test_bad_layer_fields_are_rejected(self):
        layer = dict(id='coat', name='外套')
        bad = {
            'layers without hidden_layers': [{k: v for k, v in A2C_HELLO.items() if k != 'hidden_layers'}],
            'hidden not a subset': [dict(A2C_HELLO, hidden_layers=['cape'])],
            'seventeenth layer': [dict(A2C_HELLO, layers=[dict(layer, id=f'l{i}') for i in range(17)], hidden_layers=[])],
            'empty name': [dict(A2C_HELLO, layers=[dict(layer, name='')], hidden_layers=[])],
            'kind skin': [dict(A2C_HELLO, appearances=[dict(id='default', name='默认', kind='skin')])],
            'empty layer appearances': [dict(A2C_HELLO, layers=[dict(layer, appearances=[])], hidden_layers=[])],
            'reason not in set': [A2C_HELLO, dict(v=1, type='layers_change_failed', hidden=['coat'], reason='nope')],
        }
        for name, messages in bad.items():
            with self.subTest(name):
                self.assertTrue(session('a2c', *messages))


if __name__ == '__main__':
    unittest.main()
