#!/usr/bin/env python3
"""Acceptance benchmark for the motion service.

1. cold: the first generate after start; warm: 10 more ("a person waves their right hand", 4 s, --steps, default 50), wall and X-Generate-Ms.
2. text: the first prompt of each prompt class x seeds 0-4, written as a score_p7.py motion dir (<out>/text: meta.json, joints.npz).
3. turn90: the turn90 root scene (gen_geom.py), seed 0; end error of the smooth root against the origin.
usage: bench.py --url URL [--token-file PATH] [--steps 50] --prompts prompts.json --out DIR   (prints the summary JSON)
Without --token-file the token comes from MOTION_SERVICE_TOKEN, so the service host token file needs no copy.
"""
import argparse
import io
import json
import math
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

WAVE = 'a person waves their right hand'
STEPS = 50
SECONDS = 4
# turn90 from gen_geom.py: root at the origin on frames 0, 59, 119, heading 0, pi/4, pi/2.
TURN90 = [{'t': 0/30, 'x': 0, 'z': 0, 'yaw': 0}, {'t': 59/30, 'x': 0, 'z': 0, 'yaw': math.pi/4}, {'t': 119/30, 'x': 0, 'z': 0, 'yaw': math.pi/2}]
START = [{'t': 0, 'x': 0, 'z': 0, 'yaw': 0}]  # gen_text.py's only constraint


class Client:
    def __init__(self, url, token):
        self.url, self.token = url.rstrip('/'), token

    def request(self, path, body=None, timeout=60):
        req = urllib.request.Request(self.url+path, data=None if body is None else json.dumps(body).encode(),
                                     headers={'Authorization': f'Bearer {self.token}', 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.headers, r.read()

    def wait_ready(self, seconds):
        deadline = time.monotonic()+seconds
        while True:
            try:
                return json.loads(self.request('/v1/health', timeout=5)[1])
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                if time.monotonic() > deadline: raise
                time.sleep(2)

    def generate(self, **body):
        t = time.perf_counter()
        headers, data = self.request('/v1/generate', body)
        wall = (time.perf_counter()-t)*1e3
        with np.load(io.BytesIO(data), allow_pickle=False) as z:
            motion = {k: z[k] for k in z.files}
        return motion, {'wall_ms': wall, 'generate_ms': float(headers['X-Generate-Ms']), 'encode_ms': float(headers['X-Encode-Ms']),
                        'seed': int(headers['X-Seed']), 'bytes': len(data)}


def pct(values):
    return {'p50': float(np.percentile(values, 50)), 'p95': float(np.percentile(values, 95))}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--url', required=True); p.add_argument('--token-file')
    p.add_argument('--prompts', required=True); p.add_argument('--out', required=True); p.add_argument('--wait', type=float, default=600)
    p.add_argument('--steps', type=int, default=STEPS)
    a = p.parse_args()
    classes = json.loads(Path(a.prompts).read_text())['classes']; labels = list(classes); texts = [classes[k][0] for k in labels]
    token = (Path(a.token_file).read_text() if a.token_file else os.environ['MOTION_SERVICE_TOKEN']).strip()
    c = Client(a.url, token); out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    health = c.wait_ready(a.wait); skeleton = json.loads(c.request('/v1/skeleton')[1])

    _, cold = c.generate(prompt=WAVE, seconds=SECONDS, steps=a.steps, seed=0)
    warm = [c.generate(prompt=WAVE, seconds=SECONDS, steps=a.steps, seed=s)[1] for s in range(1, 11)]

    joints, records = {}, []
    for seed in range(5):
        batch = []
        for label, text in zip(labels, texts):
            motion, r = c.generate(prompt=text, seconds=SECONDS, steps=a.steps, seed=seed, constraints={'root': START})
            batch.append(motion['posed_joints'][0].astype('f4')); records.append({'cond': 'qwen', 'seed': seed, 'label': label, **r})
        joints[f'qwen-seed{seed}'] = np.stack(batch)
    text_dir = out / 'text'; text_dir.mkdir(exist_ok=True)
    np.savez_compressed(text_dir / 'joints.npz', **joints)
    (text_dir / 'meta.json').write_text(json.dumps({'framework': 'kimodo', 'model': health['model'], 'steps': a.steps, 'frames': SECONDS*30, 'fps': 30,
        'names': skeleton['names'], 'labels': labels, 'texts': texts, 'mismatch_source_label': labels, 'records': records, 'peak_GiB': None}, indent=1))

    motion, turn = c.generate(prompt='', seconds=SECONDS, steps=a.steps, seed=0, constraints={'root': TURN90})
    root = motion['smooth_root_pos'][0][:, [0, 2]]; hv = motion['global_root_heading'][0]
    hips = motion['posed_joints'][0][:, skeleton['names'].index('Hips')]
    turn.update(end_err_cm=float(np.linalg.norm(root[-1]))*100, hips_end_err_cm=float(np.linalg.norm((hips[-1]-hips[0])[[0, 2]]))*100,
                end_heading_deg=math.degrees(math.atan2(hv[-1, 1], hv[-1, 0])))

    summary = {'health': health, 'cold': cold,
               'warm': {'wall_ms': pct([r['wall_ms'] for r in warm]), 'generate_ms': pct([r['generate_ms'] for r in warm]),
                        'encode_ms': pct([r['encode_ms'] for r in warm]), 'runs': warm},
               'text_dir': str(text_dir), 'text_wall_ms': pct([r['wall_ms'] for r in records]), 'turn90': turn}
    (out / 'bench.json').write_text(json.dumps(summary, indent=1))
    print(json.dumps({k: v for k, v in summary.items() if k != 'warm'} | {'warm': {k: v for k, v in summary['warm'].items() if k != 'runs'}}, indent=1))


if __name__ == '__main__':
    main()
