"""LoRA fine-tuning of Kimodo-SOMA-RP-v1.2 on a clip dataset, mixed with Kimodo's own samples (notes/research/
kimodo-finetune-20261105/lora-report.md). server.py --lora merges the result.

  encode      vectors of every manifest text and the eval prompts through the service's Qwen3 projection, keyed by the
              text's sha256.
  selfsample  Kimodo samples through the service's generate path: each generate body (no seed) of the --prompts JSON
              list for seeds 0..N-1, written as a dataset with the prompt as caption.
  train       rank-8 LoRA (--rank, --alpha) on the q/k/v rows of in_proj_weight in the 32 attention layers of both stages
              (--targets adds out_proj and the feed-forward linear1/linear2), the seven x0 losses of tech report eq. (1);
              <out>/lora.pt holds the EMA weights, <out>/train.jsonl and eval.jsonl the logs.
Dataset: <dir>/manifest.jsonl rows {id, npz, frames, seconds, caption, caption_template, character, category} and
<dir>/<npz> with local_rot_mats [T, 30, 3, 3], root_positions [T, 3], fps 30; a row without caption or caption_template
is skipped. Run on cuda with python -I -B and the service's environment (run-ws.sh).
"""
import argparse
import hashlib
import json
import math
import os
import random
import re
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.nn.utils import parametrize

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import backend_kimodo as bk  # noqa: E402
import server as sv  # noqa: E402
from kimodo import constraints as cs  # noqa: E402
from kimodo.geometry import cont6d_to_matrix  # noqa: E402
from kimodo.motion_rep.stats import Stats  # noqa: E402
from kimodo.skeleton.kinematics import joints_from_global_rots  # noqa: E402

DEV = 'cuda'
MAX_FRAMES = 10*sv.FPS
VAL_FRACTION = 0.05
TEXT_DROP = 0.1
WARMUP = 200
EMA_EVERY, EMA_DECAY = 10, 0.995
LOG_EVERY, EVAL_EVERY, CKPT_EVERY = 50, 500, 1000
# Tech report eq. (1), p. 10: smooth L1 per feature block plus FK positions, gamma1..gamma7.
LOSS_W = {'root_pos': 10.0, 'heading': 2.0, 'joint_pos': 10.0, 'vel': 3.0, 'rot6d': 10.0, 'contacts': 4.0, 'fk': 5.0}
BLOCKS = {'root_pos': 'smooth_root_pos', 'heading': 'global_root_heading', 'joint_pos': 'local_joints_positions',
          'vel': 'velocities', 'rot6d': 'global_rot_data', 'contacts': 'foot_contacts'}
EVAL_T = (10, 100, 250, 500, 750, 900, 990)
EVAL_PROMPTS = ('a person jumps up in place', 'a person waves with their right hand',
                'a person bends down and picks something up from the floor', 'a person stretches both arms above their head')
EVAL_SEEDS = (0, 1)
# Constraint patterns of tech report p. 11: none 10% of the time, two patterns 25%, 1..20 keyframes biased low.
PATTERNS = ('root_path', 'root_keys', 'fullbody', 'effectors')
NO_CONSTRAINTS, TWO_PATTERNS, MAX_KEYS = 0.1, 0.25, 20


def text_key(text):
    return hashlib.sha256(text.encode()).hexdigest()


def clip_text(row):
    """caption, else caption_template, stripped as the service strips a prompt; '' without either."""
    return (row.get('caption') or row.get('caption_template') or '').strip()


def read_dataset(d):
    """(clips {id, text, local_rot_mats, root_positions}, number of rows skipped for having no text)."""
    d = Path(d)
    clips, skipped = [], 0
    for line in (d/'manifest.jsonl').read_text().splitlines():
        row = json.loads(line)
        text = clip_text(row)
        if not text:
            skipped += 1
            continue
        with np.load(d/row['npz'], allow_pickle=False) as z:
            clips.append({'id': row['id'], 'text': text, 'local_rot_mats': z['local_rot_mats'], 'root_positions': z['root_positions']})
    return clips, skipped


def split_val(ids):
    """The validation ids: the 5% (at least one) whose sha256 sorts first."""
    return set(sorted(ids, key=text_key)[:math.ceil(len(ids)*VAL_FRACTION)])


def featurize(mr, clip, device):
    """Unnormalized KimodoMotionRep features [T, D] from the clip's rotations and root (FK, smoothed root, detected contacts)."""
    with torch.no_grad():
        return mr(torch.from_numpy(clip['local_rot_mats']).to(device), torch.from_numpy(clip['root_positions']).to(device), to_normalize=False)


def make_batch(mr, feats, aug):
    """Clips cut to MAX_FRAMES (a random window when aug), padded by repeating the last frame, canonicalized (a random
    heading when aug): (x0 normalized and zero past each length, pad mask [B, T], lengths, first heading angle, canonical
    unnormalized features)."""
    crops = []
    for f in feats:
        start = random.randint(0, len(f)-MAX_FRAMES) if aug and len(f) > MAX_FRAMES else 0
        crops.append(f[start:start+MAX_FRAMES])
    lens = [len(c) for c in crops]
    T, device = max(lens), crops[0].device
    # Zero padding becomes NaN in canonicalize (zero 6D rotations), and NaN*0 stays NaN (lora-report §2.9).
    x = torch.stack([torch.cat([c, c[-1:].expand(T-len(c), -1)]) for c in crops])
    pad = torch.arange(T, device=device)[None] < torch.tensor(lens, device=device)[:, None]
    x = mr.canonicalize_random_heading(x) if aug else mr.canonicalize(x)
    h0 = mr.get_first_heading_angle(x, normalized=False)
    return torch.where(pad[..., None], mr.normalize(x), 0.), pad, lens, h0, x


def _on(c, device):
    for k, v in vars(c).items():
        if torch.is_tensor(v):
            setattr(c, k, v.to(device))
    return c


def sample_constraints(mr, x, lens):
    """(observed motion, float motion mask) of constraints read off each clip's canonical features x and built with the
    constraint sets the service uses: dense root path or sparse root keys (with heading half the time), full-body
    keyframes, keyframes of one or two of the service's effector joints."""
    sk, device = mr.skeleton, x.device
    with torch.no_grad():
        m = mr.inverse(x, is_normalized=False, need_local_rots=False)
    per_clip = []
    for b, L in enumerate(lens):
        sets = []
        if random.random() >= NO_CONSTRAINTS:
            for kind in random.sample(PATTERNS, 2 if random.random() < TWO_PATTERNS else 1):
                fr = torch.randperm(L, device=device)[:1+int(min(MAX_KEYS-1, L-1)*random.random()**2)].sort().values
                if kind == 'root_path':
                    fr = torch.arange(L, device=device)
                if kind in ('root_path', 'root_keys'):
                    heading = m['global_root_heading'][b, fr] if random.random() < 0.5 else None
                    c = cs.Root2DConstraintSet(sk, fr, m['smooth_root_pos'][b, fr][:, [0, 2]], global_root_heading=heading)
                elif kind == 'fullbody':
                    c = cs.FullBodyConstraintSet(sk, fr, m['posed_joints'][b, fr], m['global_rot_mats'][b, fr])
                else:
                    c = cs.EndEffectorConstraintSet(sk, fr, m['posed_joints'][b, fr], m['global_rot_mats'][b, fr], None,
                                                    joint_names=random.sample(sv.EFFECTOR_JOINTS, random.randint(1, 2)))
                sets.append(_on(c, device))
        per_clip.append(sets)
    obs, mask = mr.create_conditions_from_constraints_batched(per_clip, torch.tensor(lens, device=device), to_normalize=True, device=device)
    return obs, mask.float()


def losses(mr, pred_n, x0_n, pad):
    """Per-sample eq. (1) terms: smooth L1 on normalized feature blocks, FK positions in metres (root-local)."""
    sk, s = mr.skeleton, mr.slice_dict

    def sl1(a, b):
        return torch.where(pad, F.smooth_l1_loss(a, b, reduction='none').mean(-1), 0.).sum(1)/pad.sum(1)
    out = {k: sl1(pred_n[..., s[blk]], x0_n[..., s[blk]]) for k, blk in BLOCKS.items()}
    pred, gt = mr.unnormalize(pred_n), mr.unnormalize(x0_n)
    B, T, _ = pred.shape
    J = sk.nbjoints
    R = cont6d_to_matrix(pred[..., s['global_rot_data']].reshape(B, T, J, 6))
    _, fk = joints_from_global_rots(R, torch.zeros(B, T, 3, device=pred.device), sk, return_norootpos=True)
    jp = gt[..., s['local_joints_positions']].reshape(B, T, J, 3)
    jp = jp-jp[:, :, sk.root_idx:sk.root_idx+1]
    out['fk'] = sl1(fk.reshape(B, T, -1), jp.reshape(B, T, -1))
    out['total'] = sum(LOSS_W[k]*out[k] for k in LOSS_W)
    return out


def lora_layers(net):
    """Names of the self-attention modules of both stages of a TwostageDenoiser."""
    return [f'{stage}.seqTransEncoder.layers.{i}.self_attn' for stage in ('root_model', 'body_model')
            for i in range(len(getattr(net, stage).seqTransEncoder.layers))]


class LoRAQKV(nn.Module):
    """Rank-r update of nn.MultiheadAttention.in_proj_weight ([3d, d]: q, k, v rows), one (A, B) pair per projection."""

    def __init__(self, d, rank, alpha):
        super().__init__()
        self.A = nn.Parameter(torch.empty(3, rank, d))
        self.B = nn.Parameter(torch.zeros(3, d, rank))
        for i in range(3):
            nn.init.kaiming_uniform_(self.A.data[i], a=math.sqrt(5))  # as peft; B = 0 starts training at the base model
        self.scale, self.enabled = alpha/rank, True

    def forward(self, w):
        return w+bk.lora_delta(self.A, self.B, self.scale) if self.enabled else w


class LoRALinear(nn.Module):
    """Rank-r update B·A of a weight [out_features, in_features]."""

    def __init__(self, out_features, in_features, rank, alpha):
        super().__init__()
        self.A = nn.Parameter(torch.empty(rank, in_features))
        self.B = nn.Parameter(torch.zeros(out_features, rank))
        nn.init.kaiming_uniform_(self.A.data, a=math.sqrt(5))
        self.scale, self.enabled = alpha/rank, True

    def forward(self, w):
        return w+self.scale*(self.B@self.A) if self.enabled else w


TARGETS = ('qkv', 'out', 'ffn')


def parse_targets(s):
    """--targets: comma-separated names of TARGETS."""
    targets = s.split(',')
    if not targets or any(t not in TARGETS for t in targets):
        raise argparse.ArgumentTypeError(f'{s!r}: comma-separated {", ".join(TARGETS)}')
    return targets


def lora_entries(layers, targets):
    """[{module, param, kind}] of the targets in each self-attention layer's encoder layer: qkv its in_proj_weight, out
    its out_proj, ffn the encoder layer's linear1 and linear2."""
    entries = []
    for layer in layers:
        enc = layer.rsplit('.', 1)[0]
        for t in targets:
            if t == 'qkv':
                entries.append({'module': layer, 'param': 'in_proj_weight', 'kind': 'qkv'})
            elif t == 'out':
                entries.append({'module': f'{layer}.out_proj', 'param': 'weight', 'kind': 'out'})
            else:
                entries.extend({'module': f'{enc}.{lin}', 'param': 'weight', 'kind': 'ffn'} for lin in ('linear1', 'linear2'))
    return entries


def add_lora_entries(net, entries, rank, alpha):
    """{bk.lora_key(entry): LoRAQKV or LoRALinear} registered as a parametrization of each entry's weight."""
    mods = {}
    for e in entries:
        m = net.get_submodule(e['module'])
        w = getattr(m, e['param'])
        mod = LoRAQKV(m.embed_dim, rank, alpha) if e['kind'] == 'qkv' else LoRALinear(*w.shape, rank, alpha)
        mods[bk.lora_key(e)] = mod.to(w.device)
        parametrize.register_parametrization(m, e['param'], mod)
    return mods


def add_lora(net, layers, rank, alpha):
    """{layer: LoRAQKV} registered as a parametrization of each layer's in_proj_weight."""
    return add_lora_entries(net, lora_entries(layers, ['qkv']), rank, alpha)


def lora_tensors(mods):
    return {f'{layer}.{n}': getattr(mod, n).detach().clone() for layer, mod in mods.items() for n in ('A', 'B')}


def save_replace(obj, path):
    """torch.save through a .tmp beside path, so an interrupted save leaves the previous file whole."""
    tmp = Path(path).with_suffix('.tmp')
    torch.save(obj, tmp)
    os.replace(tmp, path)


def save_lora(path, config, tensors):
    """lora.pt as backend_kimodo.read_lora reads it."""
    save_replace({'config': config, 'tensors': {k: v.detach().cpu() for k, v in tensors.items()}}, path)


def text_encoder_id():
    qwen, projection = bk.qwen_paths()
    return f'{qwen.name} mean-pooled through {projection.name} sha256 {bk.file_sha256(projection)}'


def manifest_texts(dirs):
    texts = {}
    for d in dirs:
        for line in (Path(d)/'manifest.jsonl').read_text().splitlines():
            text = clip_text(json.loads(line))
            if text:
                texts[text_key(text)] = text
    return texts


def encode(args):
    texts = manifest_texts(args.data)
    texts.update({text_key(p): p for p in EVAL_PROMPTS})
    backend = bk.KimodoBackend(DEV)
    with torch.inference_mode():
        vecs = {k: backend._encode(t)[0].float().cpu().clone() for k, t in texts.items()}
    torch.save({'encoder': text_encoder_id(), 'texts': texts, 'vecs': vecs}, args.out)
    print(json.dumps({'texts': len(texts), 'encoder': text_encoder_id(), 'out': args.out}))


def selfsample(args):
    bodies = json.loads(Path(args.prompts).read_text())
    out = Path(args.out)
    (out/'clips').mkdir(parents=True, exist_ok=True)
    backend = bk.KimodoBackend(DEV)
    rows = []
    for i, body in enumerate(bodies):
        for seed in range(args.seeds):
            r = sv.parse_generate(dict(body, seed=seed))
            arrays, _, _ = backend.generate(**r)
            cid = f'p{i:03d}_s{seed}'
            np.savez(out/'clips'/f'{cid}.npz', local_rot_mats=arrays['local_rot_mats'][0], root_positions=arrays['root_positions'][0], fps=sv.FPS)
            rows.append({'id': cid, 'npz': f'clips/{cid}.npz', 'frames': r['frames'], 'seconds': r['frames']/sv.FPS, 'caption': r['prompt'],
                         'caption_template': None, 'character': 'kimodo', 'category': 'selfsample'})
    (out/'manifest.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in rows))
    print(json.dumps({'clips': len(rows), 'out': str(out)}))


def service(model, vecs):
    """KimodoBackend over an already loaded model whose prompts come from vecs (prompt: [4096]) instead of Qwen."""
    b = object.__new__(bk.KimodoBackend)
    b.model, b.device, b.dev, b.sk = model, DEV, DEV, model.skeleton
    b.cache = {p: v[None] for p, v in vecs.items()}
    b._reference()
    return b


def rms(a, b):
    return float(np.sqrt(np.mean(np.sum((np.asarray(a, np.float64)-np.asarray(b, np.float64))**2, -1))))


def parse_oversample(s):
    """--oversample REGEX=FACTOR: (compiled case-insensitive REGEX, FACTOR); the last '=' splits."""
    regex, sep, factor = s.rpartition('=')
    try:
        return re.compile(regex, re.IGNORECASE), float(factor)
    except (re.error, ValueError) as e:
        raise argparse.ArgumentTypeError(f'{s!r}: REGEX=FACTOR ({e})') from None


def oversample_weights(texts, rules):
    """Sampling weight of each text: the product of the FACTOR of every rule whose REGEX it matches, 1 for none."""
    return [math.prod(f for r, f in rules if r.search(t)) for t in texts]


def lr_factor(schedule, steps):
    """LambdaLR factor at scheduler index s (the lr of step s+1): a linear WARMUP to 1, then 1 (constant) or a cosine
    from 1 at step WARMUP to 0.1 at step `steps` (cosine)."""
    def f(s):
        if s+1 < WARMUP or schedule == 'constant':
            return min(1.0, (s+1)/WARMUP)
        p = min(1.0, (s+1-WARMUP)/max(1, steps-WARMUP))
        return 0.1+0.9*0.5*(1+math.cos(math.pi*p))
    return f


def train(args):
    torch.manual_seed(args.seed)
    random.seed(args.seed)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    cache = torch.load(args.text, weights_only=True)
    model = bk.load_model(bk.MODEL, device=DEV, text_encoder=bk.NoText())
    net, mr, diff = model.denoiser.model, model.motion_rep, model.diffusion
    for p in model.parameters():
        p.requires_grad_(False)
    base_sha = bk.file_sha256(bk.base_checkpoint())
    layers = lora_layers(net)
    entries = lora_entries(layers, args.targets)
    mods = add_lora_entries(net, entries, args.rank, args.alpha)
    params = [p for mod in mods.values() for p in mod.parameters()]
    ema = lora_tensors(mods)

    raw = {'data': (args.data, *read_dataset(args.data))}
    if args.retain:
        raw['retain'] = (args.retain, *read_dataset(args.retain))
    keys = sorted({c['text'] for _, clips, _ in raw.values() for c in clips})
    missing = [t for t in keys if text_key(t) not in cache['vecs']]
    if missing:
        sys.exit(f'{len(missing)} texts are not in {args.text}, e.g. {missing[0]!r}: run encode on this data')
    vec_rows = {t: i for i, t in enumerate(keys)}
    vecs = torch.stack([cache['vecs'][text_key(t)] for t in keys]).to(DEV)
    sets = {}
    for name, (d, clips, skipped) in raw.items():
        val = split_val([c['id'] for c in clips])
        sets[name] = {'train': [], 'val': []}
        for c in clips:
            sets[name]['val' if c['id'] in val else 'train'].append((featurize(mr, c, DEV), vec_rows[c['text']]))
        print(json.dumps({'set': name, 'dir': d, 'clips': len(clips), 'skipped_without_text': skipped, 'train': len(sets[name]['train']),
                          'val': sorted(val), 'frames': sum(len(c['root_positions']) for c in clips)}), flush=True)
    weights = None
    if args.oversample:
        texts = [keys[i] for _, i in sets['data']['train']]
        weights = oversample_weights(texts, args.oversample)
        for r, f in args.oversample:
            hit = [w for t, w in zip(texts, weights) if r.search(t)]
            print(json.dumps({'oversample': r.pattern, 'factor': f, 'clips': len(hit), 'share': sum(hit)/sum(weights)}), flush=True)

    def draw():
        if args.retain and random.random() < args.retain_ratio:
            return random.choice(sets['retain']['train'])
        return random.choice(sets['data']['train']) if weights is None else random.choices(sets['data']['train'], weights)[0]

    def forward_loss(items, aug, t, noise, constraints, drop):
        x0, pad, lens, h0, x = make_batch(mr, [f for f, _ in items], aug)
        text = vecs[[i for _, i in items]][:, None]
        if drop:
            text = text*(torch.rand(len(items), 1, 1, device=DEV) >= TEXT_DROP)
        obs, mask = sample_constraints(mr, x, lens) if constraints else (None, None)
        diff.calc_diffusion_vars(torch.arange(1000, device=DEV))  # sampling leaves its own step subset in these buffers
        xt = diff.q_sample(x0, t, noise(x0))
        with torch.autocast('cuda', dtype=torch.bfloat16, enabled=args.bf16):
            pred = net(xt, pad, text, torch.ones(len(items), 1, dtype=torch.bool, device=DEV), t, h0, mask, obs)
        return losses(mr, pred.float(), x0, pad)

    def val_losses(items):
        """eq. (1) total per EVAL_T over the clips, fixed noise, no augmentation, text drop or constraints."""
        g = torch.Generator().manual_seed(1234)
        pairs = [(item, t) for item in items for t in EVAL_T]
        tot, ts = [], []
        with torch.no_grad():
            for i in range(0, len(pairs), 32):
                chunk = pairs[i:i+32]
                t = torch.tensor([t for _, t in chunk], device=DEV)
                tot.append(forward_loss([item for item, _ in chunk], False, t, lambda x: torch.randn(x.shape, generator=g).to(DEV), False, False)['total'])
                ts.append(t)
        tot, ts = torch.cat(tot), torch.cat(ts)
        return {'total': tot.mean().item(), 'by_t': {int(t): tot[ts == t].mean().item() for t in EVAL_T}}

    svc = service(model, {p: cache['vecs'][text_key(p)].to(DEV) for p in EVAL_PROMPTS})
    requests = [sv.parse_generate({'prompt': p, 'seconds': 6, 'seed': s}) for p in EVAL_PROMPTS for s in EVAL_SEEDS]

    def generate_all():
        model.eval()
        outs = [svc.generate(**r)[0] for r in requests]
        net.train()
        for mod in model.modules():  # casts cached under inference_mode cannot be saved for backward (lora-report §2.9)
            if isinstance(mod, Stats):
                mod._cast_cache.clear()
        return outs

    def swap_ema():
        for layer, mod in mods.items():
            for n in ('A', 'B'):
                live, kept = getattr(mod, n).data, ema[f'{layer}.{n}']
                tmp = live.clone()
                live.copy_(kept)
                kept.copy_(tmp)

    base = []

    def evaluate(step):
        swap_ema()
        res = {'step': step, **{f'val_{name}': val_losses(s['val']) for name, s in sets.items() if s['val']}}
        tuned = generate_all()
        swap_ema()
        if not base:
            for mod in mods.values():
                mod.enabled = False
            base.extend(generate_all())
            for mod in mods.values():
                mod.enabled = True
        rows = [{'prompt': r['prompt'], 'seed': r['seed'], 'finite': bool(all(np.isfinite(v).all() for v in a.values() if v.dtype.kind == 'f')),
                 'root_drift_m': rms(a['root_positions'][..., [0, 2]], b['root_positions'][..., [0, 2]]),
                 'pose_rms_m': rms(a['posed_joints_norootpos'], b['posed_joints_norootpos'])} for r, a, b in zip(requests, tuned, base)]
        res['gen'] = {'root_drift_m': float(np.mean([r['root_drift_m'] for r in rows])), 'pose_rms_m': float(np.mean([r['pose_rms_m'] for r in rows])),
                      'finite': all(r['finite'] for r in rows), 'per_request': rows}
        with open(out/'eval.jsonl', 'a') as f:
            f.write(json.dumps(res)+'\n')
        print('EVAL', json.dumps({k: v for k, v in res.items() if k != 'gen'} | {'gen': {k: v for k, v in res['gen'].items() if k != 'per_request'}}), flush=True)

    opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.0)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lr_factor(args.lr_schedule, args.steps))
    start = 0
    if args.resume:
        ck = torch.load(out/'ckpt.pt', weights_only=False)
        start = ck['step']
        for layer, mod in mods.items():
            for n in ('A', 'B'):
                getattr(mod, n).data.copy_(ck['lora'][f'{layer}.{n}'])
                ema[f'{layer}.{n}'].copy_(ck['ema'][f'{layer}.{n}'])
        opt.load_state_dict(ck['opt'])
        sched.load_state_dict(ck['sched'])
        random.setstate(ck['random'])
        torch.set_rng_state(ck['torch'])
        torch.cuda.set_rng_state(ck['cuda'])
    else:
        for name in ('train.jsonl', 'eval.jsonl'):
            (out/name).unlink(missing_ok=True)

    def checkpoint(step):
        save_replace({'step': step, 'lora': lora_tensors(mods), 'ema': ema, 'opt': opt.state_dict(), 'sched': sched.state_dict(),
                    'random': random.getstate(), 'torch': torch.get_rng_state(), 'cuda': torch.cuda.get_rng_state()}, out/'ckpt.pt')

    net.train()
    if not args.resume:
        evaluate(0)
    torch.cuda.reset_peak_memory_stats()
    window = []
    for step in range(start+1, args.steps+1):
        torch.cuda.synchronize()
        t0 = time.perf_counter()
        items = [draw() for _ in range(args.batch)]
        L = forward_loss(items, True, torch.randint(0, 1000, (args.batch,), device=DEV), torch.randn_like, args.constraints == 'on', True)
        loss = L['total'].mean()
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        lr = sched.get_last_lr()[0]
        sched.step()
        if step % EMA_EVERY == 0:
            with torch.no_grad():
                for k, v in lora_tensors(mods).items():
                    ema[k].mul_(EMA_DECAY).add_(v, alpha=1-EMA_DECAY)
        torch.cuda.synchronize()
        window.append((loss.item(), time.perf_counter()-t0, lr))
        if step == start+1:
            print('FIRST', json.dumps({'step': step, 'loss': window[0][0], 'sec': window[0][1]}), flush=True)
        if step % LOG_EVERY == 0 or step == args.steps:
            row = {'step': step, 'loss': float(np.mean([w[0] for w in window])), 'lr': window[-1][2],
                   'sec': float(np.mean([w[1] for w in window])), 'peak_gib': torch.cuda.max_memory_allocated()/2**30}
            with open(out/'train.jsonl', 'a') as f:
                f.write(json.dumps(row)+'\n')
            print('LOG', json.dumps(row), flush=True)
            window = []
        if step % EVAL_EVERY == 0 or step == args.steps:
            evaluate(step)
        if step % CKPT_EVERY == 0 or step == args.steps:
            checkpoint(step)
    config = {'name': out.name, 'rank': args.rank, 'alpha': args.alpha, 'layers': layers, 'targets': args.targets, 'entries': entries,
              'base_sha256': base_sha, 'text_encoder': cache['encoder'],
              'data_manifest_sha256': bk.file_sha256(Path(args.data)/'manifest.jsonl'),
              'retain_manifest_sha256': bk.file_sha256(Path(args.retain)/'manifest.jsonl') if args.retain else None,
              'steps': args.steps}
    save_lora(out/'lora.pt', config, ema)
    print('DONE', json.dumps({k: v for k, v in config.items() if k not in ('layers', 'entries')}), flush=True)


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    e = sub.add_parser('encode')
    e.add_argument('--data', action='append', required=True)
    e.add_argument('--out', required=True)
    s = sub.add_parser('selfsample')
    s.add_argument('--prompts', required=True)
    s.add_argument('--seeds', type=int, required=True)
    s.add_argument('--out', required=True)
    t = sub.add_parser('train')
    t.add_argument('--data', required=True)
    t.add_argument('--text', required=True)
    t.add_argument('--retain')
    t.add_argument('--retain-ratio', type=float, default=0.5)
    t.add_argument('--out', required=True)
    t.add_argument('--steps', type=int, default=4000)
    t.add_argument('--batch', type=int, default=32)
    t.add_argument('--lr', type=float, default=1e-4)
    t.add_argument('--bf16', action='store_true')
    t.add_argument('--constraints', choices=('off', 'on'), default='off')
    t.add_argument('--resume', action='store_true')
    t.add_argument('--seed', type=int, default=0)
    t.add_argument('--rank', type=int, default=8)
    t.add_argument('--alpha', type=float, default=16.0)
    t.add_argument('--targets', type=parse_targets, default=['qkv'], help='comma-separated qkv, out, ffn')
    t.add_argument('--oversample', type=parse_oversample, action='append', default=[], metavar='REGEX=FACTOR',
                   help='draw data clips whose caption matches REGEX (case-insensitive) FACTOR times as often; repeatable')
    t.add_argument('--lr-schedule', choices=('constant', 'cosine'), default='constant')
    args = p.parse_args()
    {'encode': encode, 'selfsample': selfsample, 'train': train}[args.cmd](args)


if __name__ == '__main__':
    main()
