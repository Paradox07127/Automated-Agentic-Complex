#!/usr/bin/env python3
"""Motion service: keeps a Kimodo backend loaded and returns one generated SOMA-30 motion per request.

GET /v1/health, GET /v1/skeleton, POST /v1/generate (npz bytes, B=1). Every request needs `Authorization: Bearer <token>`.
Generations run one at a time on one worker thread; one more may wait, further requests get 503.
usage: server.py --token-file PATH [--host 127.0.0.1] [--port 48830] [--device cuda|mps|cpu] [--default-steps 50]
                 [--half fp16|none] [--fast-sampler on|off] [--mmap-vocab on|off] [--warm-prompts PATH (JSON list of prompts)]
                 [--lora PATH (lora.pt from lora/train.py; health and skeleton report its name and sha256)]
"""
import argparse
import hmac
import io
import json
import math
import queue
import random
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np

FPS = 30
MAX_PROMPT = 300
SECONDS = (1, 10)
STEPS = (10, 100)
DEFAULT_STEPS = 50
TIMEOUT_S = 30.0
MAX_BODY = 1 << 16
CAPACITY = 2  # one running, one waiting
EFFECTOR_JOINTS = ('LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'Hips')


class BadRequest(ValueError):
    pass


def _number(v, name):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise BadRequest(f'{name} must be a finite number')
    return float(v)


def _int(v, name, lo, hi):
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise BadRequest(f'{name} must be an integer in [{lo}, {hi}]')
    return v


def _object(v, name, required, optional=()):
    if not isinstance(v, dict):
        raise BadRequest(f'{name} must be an object')
    unknown = sorted(set(v) - set(required) - set(optional))
    if unknown:
        raise BadRequest(f'unknown key in {name}: {unknown[0]}')
    missing = [k for k in required if k not in v]
    if missing:
        raise BadRequest(f'missing key in {name}: {missing[0]}')
    return v


def _list(v, name):
    if not isinstance(v, list):
        raise BadRequest(f'{name} must be a list')
    return v


def parse_generate(body, default_steps=DEFAULT_STEPS):
    """The validated generate request: prompt, frames, seed, steps (default_steps when absent), root keys and effectors with frame indices."""
    body = _object(body, 'body', ('prompt', 'seconds'), ('seed', 'steps', 'constraints'))
    prompt = body['prompt']
    if not isinstance(prompt, str) or len(prompt) > MAX_PROMPT:
        raise BadRequest(f'prompt must be a string of at most {MAX_PROMPT} characters')
    seconds = _number(body['seconds'], 'seconds')
    if not SECONDS[0] <= seconds <= SECONDS[1]:
        raise BadRequest(f'seconds must be in [{SECONDS[0]}, {SECONDS[1]}]')
    frames = round(seconds*FPS)
    seed = _int(body['seed'], 'seed', 0, 2**32-1) if 'seed' in body else random.randrange(2**32)
    steps = _int(body.get('steps', default_steps), 'steps', *STEPS)
    constraints = _object(body.get('constraints', {}), 'constraints', (), ('root', 'effectors'))

    def frame(t, name):
        t = _number(t, name)
        if not 0 <= t <= seconds:
            raise BadRequest(f'{name} must be in [0, seconds]')
        return min(round(t*FPS), frames-1)

    root = []
    for i, key in enumerate(_list(constraints.get('root', []), 'root')):
        name = f'root[{i}]'
        key = _object(key, name, ('t', 'x', 'z'), ('yaw',))
        root.append({'frame': frame(key['t'], f'{name}.t'), 'x': _number(key['x'], f'{name}.x'), 'z': _number(key['z'], f'{name}.z'),
                     'yaw': _number(key['yaw'], f'{name}.yaw') if 'yaw' in key else None})
    effectors = []
    for i, effector in enumerate(_list(constraints.get('effectors', []), 'effectors')):
        name = f'effectors[{i}]'
        effector = _object(effector, name, ('joint', 't', 'pos'))
        if not isinstance(effector['joint'], str) or effector['joint'] not in EFFECTOR_JOINTS:
            raise BadRequest(f'unknown joint in {name}: {effector["joint"]!r}')
        pos = _list(effector['pos'], f'{name}.pos')
        if len(pos) != 3:
            raise BadRequest(f'{name}.pos must have 3 numbers')
        effectors.append({'joint': effector['joint'], 'frame': frame(effector['t'], f'{name}.t'),
                          'pos': [_number(p, f'{name}.pos') for p in pos]})
    return {'prompt': prompt, 'frames': frames, 'seed': seed, 'steps': steps, 'root': root, 'effectors': effectors}


class Job:
    def __init__(self, request):
        self.request = request
        self.done = threading.Event()
        self.result = self.error = None
        self.cancelled = False


class Worker:
    """Runs backend.generate one job at a time; admits at most CAPACITY jobs in flight."""

    def __init__(self, backend):
        self.backend = backend
        self.lock = threading.Lock()
        self.inflight = 0
        self.jobs = queue.SimpleQueue()
        threading.Thread(target=self._run, name='generate', daemon=True).start()

    @property
    def busy(self):
        return self.inflight > 0

    def submit(self, request):
        with self.lock:
            if self.inflight >= CAPACITY:
                return None
            self.inflight += 1
        job = Job(request)
        self.jobs.put(job)
        return job

    def _run(self):
        while True:
            job = self.jobs.get()
            try:
                if not job.cancelled:
                    job.result = self.backend.generate(**job.request)
            except Exception as e:
                job.error = e
                if not isinstance(e, ValueError):
                    traceback.print_exc()
            finally:
                with self.lock:
                    self.inflight -= 1
                job.done.set()


def make_handler(worker, token, timeout=TIMEOUT_S, default_steps=DEFAULT_STEPS):
    expected = f'Bearer {token}'.encode()

    class Handler(BaseHTTPRequestHandler):
        def _send(self, status, body, content_type='application/json', headers=()):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            for k, v in headers:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status, obj):
            self._send(status, json.dumps(obj).encode())

        def _authorized(self):
            if hmac.compare_digest(self.headers.get('Authorization', '').encode(), expected):
                return True
            self._json(401, {'error': 'unauthorized'})
            return False

        def do_GET(self):
            if not self._authorized():
                return
            path = urlsplit(self.path).path
            if path == '/v1/health':
                b = worker.backend
                self._json(200, {'ok': True, 'model': b.model_name, 'device': b.device, 'default_steps': default_steps, 'busy': worker.busy,
                                 'half': b.half, 'fast_sampler': b.fast_sampler, 'cache_size': len(b.cache), 'warm_prompts': b.warm_prompts,
                                 'lora': b.lora})
            elif path == '/v1/skeleton':
                self._json(200, {**worker.backend.skeleton, 'lora': worker.backend.lora})
            else:
                self._json(404, {'error': 'not found'})

        def do_POST(self):
            started = time.monotonic()
            try:
                length = int(self.headers.get('Content-Length', ''))
            except ValueError:
                return self._json(400, {'error': 'Content-Length required'})
            if not 0 <= length <= MAX_BODY:
                return self._json(413, {'error': f'body larger than {MAX_BODY} bytes'})
            raw = self.rfile.read(length)  # read before replying so the client never sees a reset
            if not self._authorized():
                return
            if urlsplit(self.path).path != '/v1/generate':
                return self._json(404, {'error': 'not found'})
            try:
                request = parse_generate(json.loads(raw), default_steps)
            except ValueError as e:  # BadRequest, JSONDecodeError, UnicodeDecodeError
                return self._json(400, {'error': str(e)})
            job = worker.submit(request)
            if job is None:
                return self._json(503, {'error': 'busy'})
            if not job.done.wait(max(0.0, timeout-(time.monotonic()-started))):
                job.cancelled = True
                return self._json(504, {'error': 'timeout'})
            if job.error is not None:
                if isinstance(job.error, ValueError):
                    return self._json(400, {'error': str(job.error)})
                return self._json(500, {'error': 'generation failed'})
            motion, encode_ms, generate_ms = job.result
            buf = io.BytesIO()
            np.savez(buf, fps=FPS, **motion)
            self._send(200, buf.getvalue(), 'application/octet-stream',
                       [('X-Generate-Ms', f'{generate_ms:.1f}'), ('X-Encode-Ms', f'{encode_ms:.1f}'), ('X-Seed', str(request['seed']))])

    return Handler


def serve(backend, token, host, port, timeout=TIMEOUT_S, default_steps=DEFAULT_STEPS):
    """A bound ThreadingHTTPServer (not yet serving) over a fresh worker for backend."""
    worker = Worker(backend)
    server = ThreadingHTTPServer((host, port), make_handler(worker, token, timeout, default_steps))
    server.daemon_threads = True
    server.worker = worker
    return server


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--token-file', required=True)
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--port', type=int, default=48830)
    p.add_argument('--device', choices=('cuda', 'mps', 'cpu'), default='cuda')
    p.add_argument('--default-steps', type=int, default=DEFAULT_STEPS)
    p.add_argument('--half', choices=('fp16', 'none'), default='none')
    p.add_argument('--fast-sampler', choices=('on', 'off'), default='off')
    p.add_argument('--mmap-vocab', choices=('on', 'off'), default='off')
    p.add_argument('--warm-prompts')
    p.add_argument('--lora')
    args = p.parse_args()
    if not STEPS[0] <= args.default_steps <= STEPS[1]:
        p.error(f'--default-steps must be in [{STEPS[0]}, {STEPS[1]}]')
    token = Path(args.token_file).read_text().strip()
    if not token:
        sys.exit(f'empty token file: {args.token_file}')
    warm = json.loads(Path(args.warm_prompts).read_text()) if args.warm_prompts else []
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from backend_kimodo import KimodoBackend
    backend = KimodoBackend(args.device, half=args.half, fast_sampler=args.fast_sampler == 'on', mmap_vocab=args.mmap_vocab == 'on',
                            warm_prompts=warm, lora=args.lora)
    server = serve(backend, token, args.host, args.port, default_steps=args.default_steps)
    print(f'listening on {args.host}:{args.port} model {backend.model_name} device {args.device} default steps {args.default_steps} '
          f'half {args.half} fast sampler {args.fast_sampler} mmap vocab {args.mmap_vocab} warm prompts {len(warm)} lora {backend.lora}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
