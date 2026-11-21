import json
import random
import sys
import tempfile
import threading
import types
import unittest
import urllib.request
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'lora'))
import backend_kimodo as bk  # noqa: E402
import server  # noqa: E402
import train  # noqa: E402
from kimodo.motion_rep import KimodoMotionRep  # noqa: E402
from kimodo.motion_rep.stats import Stats  # noqa: E402
from kimodo.skeleton import SOMASkeleton30  # noqa: E402

D, R, ALPHA = 16, 4, 8.0
LAYERS = ['blocks.0.att', 'blocks.1.att']


class Net(nn.Module):
    """Two attention layers under the dotted names merge_lora and add_lora address."""

    def __init__(self):
        super().__init__()
        self.blocks = nn.ModuleList([nn.Module() for _ in range(2)])
        for b in self.blocks:
            b.att = nn.MultiheadAttention(D, 2, batch_first=True)

    def forward(self, x):
        for b in self.blocks:
            x = b.att(x, x, x, need_weights=False)[0]
        return x


def config(base_sha256='a'*64):
    return {'name': 'tiny', 'rank': R, 'alpha': ALPHA, 'layers': LAYERS, 'base_sha256': base_sha256}


def tensors(zero_b):
    g = torch.Generator().manual_seed(1)
    return {f'{layer}.{n}': (torch.zeros(3, D, R) if n == 'B' and zero_b else torch.randn((3, R, D) if n == 'A' else (3, D, R), generator=g))
            for layer in LAYERS for n in ('A', 'B')}


class MergeTest(unittest.TestCase):
    def test_zero_b_merge_leaves_in_proj_weight_bit_identical(self):
        torch.manual_seed(0)
        net = Net()
        before = [net.get_submodule(layer).in_proj_weight.detach().clone() for layer in LAYERS]
        bk.merge_lora(net, config(), tensors(zero_b=True))
        for layer, w in zip(LAYERS, before):
            self.assertTrue(torch.equal(net.get_submodule(layer).in_proj_weight.detach().view(torch.int32), w.view(torch.int32)))

    def test_parametrized_forward_matches_merged_forward(self):
        torch.manual_seed(0)
        tuned, merged = Net().eval(), Net().eval()
        merged.load_state_dict(tuned.state_dict())
        mods = train.add_lora(tuned, LAYERS, R, ALPHA)
        t = tensors(zero_b=False)
        for layer, mod in mods.items():
            mod.A.data.copy_(t[layer+'.A'])
            mod.B.data.copy_(t[layer+'.B'])
        bk.merge_lora(merged, config(), t)
        x = torch.randn(2, 7, D)
        with torch.no_grad():
            a, b = tuned(x), merged(x)
            mods[LAYERS[0]].enabled = False
            off = tuned(x)
        self.assertLessEqual((a-b).abs().max().item(), 1e-6)
        self.assertGreater((a-off).abs().max().item(), 1e-3)


class EncoderNet(nn.Module):
    """Both stages of a TwostageDenoiser as lora_layers names them, two torch encoder layers each (Kimodo's backbone)."""

    def __init__(self):
        super().__init__()
        for stage in ('root_model', 'body_model'):
            m = nn.Module()
            m.seqTransEncoder = nn.TransformerEncoder(nn.TransformerEncoderLayer(D, 2, 2*D, dropout=0.0, batch_first=True), 2,
                                                      enable_nested_tensor=False)
            setattr(self, stage, m)


class TargetsTest(unittest.TestCase):
    def parametrized(self, targets):
        """(parametrized net, an unparametrized copy of its base, entries, trained-like tensors with B random)."""
        torch.manual_seed(0)
        tuned, merged = EncoderNet(), EncoderNet()
        merged.load_state_dict(tuned.state_dict())
        entries = train.lora_entries(train.lora_layers(tuned), targets)
        mods = train.add_lora_entries(tuned, entries, R, ALPHA)
        g = torch.Generator().manual_seed(2)
        for mod in mods.values():
            mod.B.data.copy_(torch.randn(mod.B.shape, generator=g))
        return tuned, merged, entries, train.lora_tensors(mods)

    def weight(self, net, entry):
        return getattr(net.get_submodule(entry['module']), entry['param']).detach()

    def test_every_target_merges_to_its_parametrized_weight(self):
        tuned, merged, entries, t = self.parametrized(train.parse_targets('qkv,out,ffn'))
        self.assertEqual(sorted({e['kind'] for e in entries}), ['ffn', 'out', 'qkv'])
        base = [self.weight(merged, e).clone() for e in entries]
        bk.merge_lora(merged, {**config(), 'layers': train.lora_layers(tuned), 'targets': ['qkv', 'out', 'ffn'], 'entries': entries}, t)
        for kind in ('qkv', 'out', 'ffn'):
            es = [(e, w) for e, w in zip(entries, base) if e['kind'] == kind]
            self.assertLessEqual(max((self.weight(tuned, e)-self.weight(merged, e)).abs().max().item() for e, _ in es), 1e-6, kind)
            self.assertGreater(min((self.weight(merged, e)-w).abs().max().item() for e, w in es), 1e-3, kind)

    def test_a_config_without_entries_merges_qkv_only(self):
        tuned, merged, entries, t = self.parametrized(['qkv'])
        layers = train.lora_layers(tuned)
        self.assertEqual(sorted(t), sorted(f'{layer}.{n}' for layer in layers for n in ('A', 'B')))
        before = {k: v.clone() for k, v in merged.state_dict().items()}
        bk.merge_lora(merged, {**config(), 'layers': layers}, t)
        for e in entries:
            self.assertLessEqual((self.weight(tuned, e)-self.weight(merged, e)).abs().max().item(), 1e-6)
        for k, v in merged.state_dict().items():
            if not k.endswith('in_proj_weight'):
                self.assertTrue(torch.equal(v, before[k]), k)


class TrainOptionsTest(unittest.TestCase):
    def test_oversample_walk_by_8(self):
        texts = ['A person Walks forward', 'a person walking in a circle'] + [f'a person waves {i}' for i in range(8)]
        w = train.oversample_weights(texts, [train.parse_oversample('walk=8')])
        draws = random.Random(0).choices(range(10), weights=w, k=10000)
        self.assertAlmostEqual(sum(d < 2 for d in draws)/10000, 16/24, delta=0.02)

    def test_cosine_lr_at_warmup_end_midpoint_and_last_step_and_on_resume(self):
        steps, lr = 4000, 1e-4

        def run(first, last, state=None):
            opt = torch.optim.SGD([nn.Parameter(torch.zeros(1))], lr=lr)
            sched = torch.optim.lr_scheduler.LambdaLR(opt, train.lr_factor('cosine', steps))
            if state:
                opt.load_state_dict(state[0])
                sched.load_state_dict(state[1])
            lrs = {}
            for step in range(first, last+1):  # as train's loop: the lr step `step` trains with
                lrs[step] = sched.get_last_lr()[0]
                opt.step()
                sched.step()
            return lrs, (opt.state_dict(), sched.state_dict())

        lrs, _ = run(1, steps)
        self.assertAlmostEqual(lrs[train.WARMUP], lr)
        self.assertAlmostEqual(lrs[(train.WARMUP+steps)//2], 0.55*lr)
        self.assertAlmostEqual(lrs[steps], 0.1*lr)
        self.assertLess(lrs[train.WARMUP-1], lr)
        _, state = run(1, 2000)
        resumed, _ = run(2001, steps, state)
        self.assertEqual(resumed, {s: lrs[s] for s in range(2001, steps+1)})

    def test_constant_lr_is_the_warmup_ramp_then_lr(self):
        f = train.lr_factor('constant', 4000)
        self.assertEqual([f(s) for s in (0, 99, 199, 200, 3999)], [1/200, 0.5, 1.0, 1.0, 1.0])


class LoraFileTest(unittest.TestCase):
    def test_round_trip_and_base_sha_check(self):
        tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        cfg, t = config('b'*64), tensors(zero_b=False)
        train.save_lora(tmp/'lora.pt', cfg, t)
        got_cfg, got, sha = bk.read_lora(tmp/'lora.pt', 'b'*64)
        self.assertEqual(got_cfg, cfg)
        self.assertEqual(sorted(got), sorted(t))
        for k in t:
            self.assertTrue(torch.equal(got[k], t[k]))
        self.assertEqual(sha, bk.file_sha256(tmp/'lora.pt'))
        with self.assertRaisesRegex(ValueError, 'base checkpoint'):
            bk.read_lora(tmp/'lora.pt', 'c'*64)


class DatasetTest(unittest.TestCase):
    def write_clip(self, d, cid, frames):
        yaw = np.linspace(0, 0.5, frames)
        rot = np.tile(np.eye(3, dtype=np.float32), (frames, 30, 1, 1))
        rot[:, 0] = [[[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]] for a in yaw]
        root = np.stack([np.zeros(frames), np.full(frames, 0.9), np.linspace(0, 1, frames)], -1).astype(np.float32)
        np.savez(d/'clips'/f'{cid}.npz', local_rot_mats=rot, root_positions=root, fps=30)

    def test_rows_without_text_are_skipped_and_padding_has_no_nan(self):
        d = Path(self.enterContext(tempfile.TemporaryDirectory()))
        (d/'clips').mkdir()
        rows = [{'id': 'a', 'caption': 'a person walks', 'caption_template': None, 'frames': 20},
                {'id': 'b', 'caption_template': 'a person turns left', 'frames': 33},
                {'id': 'c', 'caption': None, 'caption_template': None, 'frames': 25}]
        for r in rows:
            self.write_clip(d, r['id'], r['frames'])
        (d/'manifest.jsonl').write_text(''.join(json.dumps({**r, 'npz': f'clips/{r["id"]}.npz', 'seconds': r['frames']/30,
                                                            'character': 'x', 'category': 'y'})+'\n' for r in rows))
        clips, skipped = train.read_dataset(d)
        self.assertEqual(([c['id'] for c in clips], [c['text'] for c in clips], skipped), (['a', 'b'], ['a person walks', 'a person turns left'], 1))
        mr = KimodoMotionRep(SOMASkeleton30(), 30)
        mr.stats = Stats()
        mr.stats.register_from_tensors(torch.zeros(mr.motion_rep_dim), torch.ones(mr.motion_rep_dim))
        feats = [train.featurize(mr, c, 'cpu') for c in clips]
        for aug in (False, True):
            x0, pad, lens, h0, _ = train.make_batch(mr, feats, aug)
            self.assertEqual((tuple(x0.shape), lens), ((2, 33, mr.motion_rep_dim), [20, 33]))
            self.assertTrue(torch.isfinite(x0).all() and torch.isfinite(h0).all())
            self.assertTrue(torch.equal(pad, torch.arange(33)[None] < torch.tensor([[20], [33]])))
            self.assertTrue((x0[0, 20:] == 0).all())
            self.assertTrue((x0[0, :20] != 0).any(-1).all())


class ServerLoraTest(unittest.TestCase):
    def test_health_and_skeleton_report_the_lora_or_null(self):
        for lora in (None, {'name': 'smoke', 'sha256': 'd'*64}):
            backend = types.SimpleNamespace(model_name='m', device='cpu', half='none', fast_sampler=False, cache={}, warm_prompts=0,
                                            skeleton={'names': ['Hips']}, lora=lora)
            httpd = server.serve(backend, 'tok', '127.0.0.1', 0)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            self.addCleanup(httpd.server_close)
            self.addCleanup(httpd.shutdown)
            for path, extra in (('/v1/health', {}), ('/v1/skeleton', {'names': ['Hips']})):
                req = urllib.request.Request(f'http://127.0.0.1:{httpd.server_address[1]}{path}', headers={'Authorization': 'Bearer tok'})
                with urllib.request.urlopen(req, timeout=10) as r:
                    reply = json.loads(r.read())
                self.assertEqual(reply['lora'], lora)
                self.assertEqual({k: reply[k] for k in extra}, extra)


if __name__ == '__main__':
    unittest.main()
