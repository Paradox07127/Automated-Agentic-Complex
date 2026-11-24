import io
import json
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402

TOKEN = 'test-token'
J = 30


class FakeBackend:
    """SOMA-30-shaped zeros; with a gate, each generate blocks until the gate opens."""
    model_name = 'Kimodo-SOMA-RP-v1.2'
    device = 'cpu'
    skeleton = {'names': [f'j{i}' for i in range(J)], 'parents': [-1]+[0]*(J-1), 'neutral_joints': [[0, 0, 0]]*J, 'foot_indices': [24, 25, 28, 29]}

    def __init__(self, gate=None, half='none', fast_sampler=False, mmap_vocab=False, warm_prompts=(), lora=None):
        self.gate = gate
        self.lora = lora
        self.started = threading.Semaphore(0)
        self.requests = []
        self.half, self.fast_sampler, self.mmap_vocab = half, fast_sampler, mmap_vocab
        self.cache = {p: None for p in warm_prompts}
        self.warm_prompts = len(warm_prompts)

    def generate(self, prompt, frames, seed, steps, root, effectors):
        self.requests.append(dict(prompt=prompt, frames=frames, seed=seed, steps=steps, root=root, effectors=effectors))
        self.started.release()
        if self.gate is not None:
            self.gate.wait()
        motion = {'posed_joints': np.zeros((1, frames, J, 3), 'f4'), 'global_rot_mats': np.tile(np.eye(3, dtype='f4'), (1, frames, J, 1, 1)),
                  'foot_contacts': np.zeros((1, frames, 4), 'f4')}
        return motion, 12.5, 345.6


class ServerTest(unittest.TestCase):
    def start(self, backend, timeout=server.TIMEOUT_S, default_steps=server.DEFAULT_STEPS):
        self.backend = backend
        self.httpd = server.serve(backend, TOKEN, '127.0.0.1', 0, timeout, default_steps)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.url = f'http://127.0.0.1:{self.httpd.server_address[1]}'

    def call(self, path, body=None, token=TOKEN, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.url+path, data=data, method='POST' if data is not None else 'GET')
        if token is not None:
            req.add_header('Authorization', f'Bearer {token}')
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            with e:
                return e.code, dict(e.headers), e.read()

    def test_post_authentication_and_body_deadline_precede_generation(self):
        handler = object.__new__(server.make_handler(mock.Mock(), TOKEN, timeout=.1))
        handler.path = '/v1/generate'
        handler.headers = {'Content-Length': '1'}
        handler.rfile = mock.Mock()
        handler.rfile.read.side_effect = AssertionError('read before authentication')
        handler._json = mock.Mock()
        handler.do_POST()
        self.assertEqual(handler._json.call_args.args[0], 401)
        handler.headers['Authorization'] = 'Bearer ' + TOKEN
        handler.connection = mock.Mock()
        handler.rfile.read1.side_effect = TimeoutError
        handler.rfile.read.side_effect = TimeoutError
        handler.do_POST()
        self.assertEqual(handler._json.call_args.args[0], 408)
        self.assertGreater(handler.connection.settimeout.call_args.args[0], 0)
        self.assertLessEqual(handler.connection.settimeout.call_args.args[0], .1)

    def test_health_and_skeleton(self):
        self.start(FakeBackend())
        status, _, body = self.call('/v1/health')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'ok': True, 'model': 'Kimodo-SOMA-RP-v1.2', 'device': 'cpu', 'default_steps': 50, 'busy': False,
                                            'half': 'none', 'fast_sampler': False, 'cache_size': 0, 'warm_prompts': 0, 'lora': None})
        status, _, body = self.call('/v1/skeleton')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {**FakeBackend.skeleton, 'lora': None})

    def test_main_passes_the_options_to_the_backend_and_health_reports_them(self):
        made = []

        def backend(*args, **kwargs):
            made.append((args, kwargs))
            return FakeBackend(**kwargs)

        tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        (tmp / 'token').write_text(TOKEN)
        (tmp / 'warm.json').write_text(json.dumps(['a person sits down on a stool', 'a person stands up from a stool']))
        argv = ['server.py', '--token-file', str(tmp / 'token'), '--port', '0', '--device', 'mps', '--half', 'fp16',
                '--fast-sampler', 'on', '--mmap-vocab', 'on', '--warm-prompts', str(tmp / 'warm.json')]
        served = []
        with mock.patch.object(sys, 'argv', argv), mock.patch.dict(sys.modules, {'backend_kimodo': types.SimpleNamespace(KimodoBackend=backend)}), \
                mock.patch.object(server, 'serve', lambda *a, **k: served.append((a, k)) or mock.Mock()), redirect_stdout(io.StringIO()):
            server.main()
        self.assertEqual(made, [(('mps',), {'half': 'fp16', 'fast_sampler': True, 'mmap_vocab': True,
                                            'warm_prompts': ['a person sits down on a stool', 'a person stands up from a stool'], 'lora': None})])
        self.start(served[0][0][0])
        health = json.loads(self.call('/v1/health')[2])
        self.assertEqual({k: health[k] for k in ('half', 'fast_sampler', 'cache_size', 'warm_prompts')},
                         {'half': 'fp16', 'fast_sampler': True, 'cache_size': 2, 'warm_prompts': 2})

    def test_main_defaults_keep_fp32_the_original_sampler_and_no_warm_prompts(self):
        made = []
        tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        (tmp / 'token').write_text(TOKEN)
        with mock.patch.object(sys, 'argv', ['server.py', '--token-file', str(tmp / 'token')]), \
                mock.patch.dict(sys.modules, {'backend_kimodo': types.SimpleNamespace(KimodoBackend=lambda *a, **k: made.append((a, k)) or FakeBackend(**k))}), \
                mock.patch.object(server, 'serve', lambda *a, **k: mock.Mock()), redirect_stdout(io.StringIO()):
            server.main()
        self.assertEqual(made, [(('cuda',), {'half': 'none', 'fast_sampler': False, 'mmap_vocab': False, 'warm_prompts': [], 'lora': None})])

    def test_missing_or_wrong_token_is_401(self):
        self.start(FakeBackend())
        for token in [None, 'wrong', TOKEN+'x']:
            self.assertEqual(self.call('/v1/health', token=token)[0], 401)
            self.assertEqual(self.call('/v1/generate', {'prompt': 'a', 'seconds': 2}, token=token)[0], 401)
        self.assertEqual(self.backend.requests, [])

    def test_bad_body_is_400(self):
        self.start(FakeBackend())
        bad = [
            {'seconds': 2},
            {'prompt': 'a'},
            {'prompt': 'a', 'seconds': 2, 'extra': 1},
            {'prompt': 'a'*301, 'seconds': 2},
            {'prompt': 3, 'seconds': 2},
            {'prompt': 'a', 'seconds': 0.5},
            {'prompt': 'a', 'seconds': 10.5},
            {'prompt': 'a', 'seconds': True},
            {'prompt': 'a', 'seconds': 2, 'steps': 9},
            {'prompt': 'a', 'seconds': 2, 'steps': 101},
            {'prompt': 'a', 'seconds': 2, 'steps': 50.0},
            {'prompt': 'a', 'seconds': 2, 'seed': -1},
            {'prompt': 'a', 'seconds': 2, 'seed': '1'},
            {'prompt': 'a', 'seconds': 2, 'constraints': []},
            {'prompt': 'a', 'seconds': 2, 'constraints': {'hands': []}},
            {'prompt': 'a', 'seconds': 2, 'constraints': {'root': [{'t': 0, 'x': 0}]}},
            {'prompt': 'a', 'seconds': 2, 'constraints': {'root': [{'t': 0, 'x': 0, 'z': 0, 'heading': 0}]}},
            {'prompt': 'a', 'seconds': 2, 'constraints': {'root': [{'t': 3, 'x': 0, 'z': 0}]}},
            {'prompt': 'a', 'seconds': 2, 'constraints': {'effectors': [{'joint': 'Head', 't': 0, 'pos': [0, 1, 0]}]}},
            {'prompt': 'a', 'seconds': 2, 'constraints': {'effectors': [{'joint': 'RightHand', 't': 0, 'pos': [0, 1]}]}},
            {'prompt': 'a', 'seconds': 2, 'constraints': {'effectors': [{'joint': 'RightHand', 't': 0, 'pos': [0, 1, 0], 'rot': 0}]}},
            [],
        ]
        for body in bad:
            with self.subTest(body=body):
                status, _, reply = self.call('/v1/generate', body)
                self.assertEqual(status, 400)
                self.assertIn('error', json.loads(reply))
        self.assertEqual(self.call('/v1/generate', raw=b'{not json')[0], 400)
        self.assertEqual(self.call('/v1/generate', raw=b'\xff\xfe')[0], 400)
        huge = b'{"prompt": "a", "seconds": 1' + b'0'*400 + b'}'
        with self.assertRaises(server.BadRequest):
            server.parse_generate(json.loads(huge))
        self.assertEqual(self.call('/v1/generate', raw=huge)[0], 400)
        self.assertEqual(self.backend.requests, [])

    def test_npz_has_the_four_keys_with_their_shapes(self):
        self.start(FakeBackend())
        body = {'prompt': 'a person waves their right hand', 'seconds': 4, 'seed': 7, 'steps': 20,
                'constraints': {'root': [{'t': 0, 'x': 0, 'z': 0, 'yaw': 0}, {'t': 4, 'x': 0.5, 'z': 1}],
                                'effectors': [{'joint': 'RightHand', 't': 2, 'pos': [0.2, 1.3, 0.4]}]}}
        status, headers, reply = self.call('/v1/generate', body)
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'application/octet-stream')
        self.assertEqual((headers['X-Seed'], headers['X-Encode-Ms'], headers['X-Generate-Ms']), ('7', '12.5', '345.6'))
        with np.load(io.BytesIO(reply), allow_pickle=False) as z:
            self.assertEqual(int(z['fps']), 30)
            self.assertEqual(z['posed_joints'].shape, (1, 120, J, 3))
            self.assertEqual(z['global_rot_mats'].shape, (1, 120, J, 3, 3))
            self.assertEqual(z['foot_contacts'].shape, (1, 120, 4))
        self.assertEqual(self.backend.requests, [{'prompt': 'a person waves their right hand', 'frames': 120, 'seed': 7, 'steps': 20,
            'root': [{'frame': 0, 'x': 0.0, 'z': 0.0, 'yaw': 0.0}, {'frame': 119, 'x': 0.5, 'z': 1.0, 'yaw': None}],
            'effectors': [{'joint': 'RightHand', 'frame': 60, 'pos': [0.2, 1.3, 0.4]}]}])

    def test_defaults_and_random_seed(self):
        self.start(FakeBackend())
        status, headers, _ = self.call('/v1/generate', {'prompt': '', 'seconds': 1})
        self.assertEqual(status, 200)
        request = self.backend.requests[0]
        self.assertEqual((request['steps'], request['frames'], request['root'], request['effectors']), (50, 30, [], []))
        self.assertEqual(headers['X-Seed'], str(request['seed']))

    def test_default_steps_applies_when_steps_is_missing(self):
        self.start(FakeBackend(), default_steps=20)
        self.assertEqual(self.call('/v1/generate', {'prompt': 'a', 'seconds': 1})[0], 200)
        self.assertEqual(self.call('/v1/generate', {'prompt': 'a', 'seconds': 1, 'steps': 50})[0], 200)
        self.assertEqual([r['steps'] for r in self.backend.requests], [20, 50])
        health = json.loads(self.call('/v1/health')[2])
        self.assertEqual((health['device'], health['default_steps']), ('cpu', 20))

    def test_one_runs_one_waits_the_rest_get_503(self):
        gate = threading.Event()
        self.start(FakeBackend(gate))
        results = {}

        def post(name):
            results[name] = self.call('/v1/generate', {'prompt': name, 'seconds': 1})

        first = threading.Thread(target=post, args=('first',)); first.start()
        self.assertTrue(self.backend.started.acquire(timeout=5))  # first is running
        second = threading.Thread(target=post, args=('second',)); second.start()
        for _ in range(250):  # until second holds the waiting slot
            if self.httpd.worker.inflight == 2:
                break
            time.sleep(0.02)
        self.assertEqual(self.httpd.worker.inflight, 2)
        status, _, reply = self.call('/v1/generate', {'prompt': 'third', 'seconds': 1})
        self.assertEqual((status, json.loads(reply)), (503, {'error': 'busy'}))
        self.assertTrue(json.loads(self.call('/v1/health')[2])['busy'])
        gate.set()
        first.join(10); second.join(10)
        self.assertEqual((results['first'][0], results['second'][0]), (200, 200))
        self.assertEqual([r['prompt'] for r in self.backend.requests], ['first', 'second'])
        self.assertFalse(json.loads(self.call('/v1/health')[2])['busy'])

    def test_past_timeout_is_504(self):
        gate = threading.Event()
        self.start(FakeBackend(gate), timeout=0.2)
        self.addCleanup(gate.set)
        status, _, reply = self.call('/v1/generate', {'prompt': 'slow', 'seconds': 1})
        self.assertEqual((status, json.loads(reply)), (504, {'error': 'timeout'}))


if __name__ == '__main__':
    unittest.main()
