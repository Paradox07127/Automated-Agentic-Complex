"""Kimodo-SOMA-RP-v1.2 and its Qwen3-8B text path, loaded once on a cuda, mps or cpu device.

Text: Qwen3-8B mean-pooled last hidden state through the community projection, one prompt per call (p7/ws_p7_encode.py),
injected as one text token with cfg_weight [2, 2] (gen_text.py). An empty prompt takes the constraints-only branch,
zero text and cfg_weight [0, 2] (gen_geom.py). Output is the native SOMA-30 motion_rep.inverse, without post-processing.
Needs CHECKPOINT_DIR, CHECKPOINTS_DIR, MOTION_QWEN (the Qwen3-8B directory), MOTION_QWEN_PROJECTION (the projection
safetensors) and HF_HUB_OFFLINE=1.
Encoded prompts are cached by string. Options: both transformer stages in fp16, a sampler loop without host syncs
(same output), Qwen's vocabulary rows read from the mmap'd safetensors instead of a table on the device, and a LoRA
(lora/train.py) merged into the attention in_proj weights (and out_proj, feed-forward weights when trained on them).
"""
import functools
import hashlib
import io
import json
import math
import os
import time
from pathlib import Path

import numpy as np
import torch
from safetensors import safe_open
from safetensors.torch import load_file
from transformers import AutoModel, AutoTokenizer
import kimodo
from kimodo import load_model
from kimodo import constraints as cs
from kimodo.model.backbone import TransformerEncoderBlock, pad_x_and_mask_to_fixed_size

MODEL = 'Kimodo-SOMA-RP-v1.2'
# kimodo is an editable install of its checkout, so the demo assets sit next to the package.
EXAMPLE = Path(kimodo.__file__).parent / 'assets/demo/examples/kimodo-soma-rp/04_ee_constraint/constraints.json'
TEXT_DIM = 4096
# (upper, middle, end) joints the effector IK bends; a Hips effector moves the whole reference pose.
LIMBS = {'LeftHand': ('LeftArm', 'LeftForeArm', 'LeftHand'), 'RightHand': ('RightArm', 'RightForeArm', 'RightHand'),
         'LeftFoot': ('LeftLeg', 'LeftShin', 'LeftFoot'), 'RightFoot': ('RightLeg', 'RightShin', 'RightFoot')}
CACHE = 256  # encoded prompts kept; the oldest goes first
# The parts of each transformer stage that --half casts; the skeleton and motion_rep stay fp32.
HALF_PARTS = ('embed_text', 'sequence_pos_encoder', 'embed_timestep', 'input_linear', 'output_linear', 'linear_first_heading_angle', 'seqTransEncoder')


class NoText:
    def __call__(self, texts):
        raise RuntimeError('text vectors are injected; Kimodo loads no encoder')


def swing(a, b):
    """Shortest rotation taking direction a to direction b (gen_geom.py)."""
    a = a/torch.linalg.norm(a); b = b/torch.linalg.norm(b); v = torch.linalg.cross(a, b); c = torch.dot(a, b); z = v[0]*0
    K = torch.stack([torch.stack([z, -v[2], v[1]]), torch.stack([v[2], z, -v[0]]), torch.stack([-v[1], v[0], z])])
    return torch.eye(3, device=a.device) + K + K @ K/(1+c).clamp_min(1e-7)


def yaw_rotation(angle, device):
    """Rotation about +Y that raises Kimodo's heading angle (atan2 of the right-to-left hip vector) by angle."""
    c, s = math.cos(angle), math.sin(angle)
    return torch.tensor([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=torch.float32, device=device)


def sync(device):
    """Wait for the work queued on device, so a timer around it measures the work."""
    if device == 'cuda':
        torch.cuda.synchronize()
    elif device == 'mps':
        torch.mps.synchronize()


def _forward_unmasked(self, x, x_pad_mask, text_feat, text_feat_pad_mask, timesteps, first_heading_angle=None):
    """TransformerEncoderBlock.forward (backbone.py:156-232) without its padding mask, which is all False here:
    use_text_mask is off and the service pads no frame."""
    x = self.input_linear(x)
    if self.num_text_tokens is not None:
        text_feat, text_feat_pad_mask = pad_x_and_mask_to_fixed_size(text_feat, text_feat_pad_mask, self.num_text_tokens)
    prefix = torch.cat((self.embed_text(text_feat), self.embed_timestep(timesteps)), axis=1)
    if self.input_first_heading_angle:
        h = self.linear_first_heading_angle(torch.stack([torch.cos(first_heading_angle), torch.sin(first_heading_angle)], axis=-1))
        prefix = torch.cat((prefix, h[:, None]), axis=1)
    n = prefix.shape[1]
    out = self.seqTransEncoder(self.sequence_pos_encoder(torch.cat((prefix, x), axis=1)), src_key_padding_mask=None)
    return self.output_linear(out[:, n:])


def _half_forward(block, forward, x, x_pad_mask, text_feat, text_feat_pad_mask, timesteps, first_heading_angle=None):
    """forward on an fp16 block: float inputs cast in, the output cast back to fp32."""
    return forward(block, x.half(), x_pad_mask, text_feat.half(), text_feat_pad_mask, timesteps,
                   None if first_heading_angle is None else first_heading_angle.half()).float()


def _generate_fast(self, schedules, texts, max_frames, num_denoising_steps, pad_mask, first_heading_angle, motion_mask, observed_motion,
                   cfg_weight=2.0, text_feat=None, text_pad_mask=None, guide_masks=None, cfg_type=None, progress_bar=None):
    """Kimodo._generate (kimodo_model.py:562-634) with denoising_step, separated CFG (cfg.py:94-129) and DDIMSampler
    (diffusion.py:118-132) inlined: the same tensor ops in the same order, but the schedule is built once per step count
    and the CFG inputs once per request, instead of every step."""
    assert text_feat is not None and cfg_type == 'separated' and guide_masks is None
    dev = self.device
    if motion_mask is not None and motion_mask.dtype == torch.bool:
        motion_mask = 1*motion_mask
    B = text_feat.shape[0]
    cur = torch.randn((B, max_frames, self.motion_rep.motion_rep_dim), device=dev)
    n = int(num_denoising_steps)
    if n not in schedules:
        use_t, map_t = self.diffusion.space_timesteps(torch.tensor([n], device=dev)[0])
        self.diffusion.calc_diffusion_vars(use_t); d = self.diffusion
        schedules[n] = (map_t, d.sqrt_recip_alphas_cumprod, d.sqrt_recipm1_alphas_cumprod, d.alphas_cumprod_prev)
    map_t, sra, srm1, acp = schedules[n]
    w0, w1 = cfg_weight
    tf3 = torch.concatenate([text_feat, 0*text_feat, 0*text_feat], dim=0)
    mm3 = None if motion_mask is None else torch.concatenate([0*motion_mask, motion_mask, 0*motion_mask], dim=0)
    ob3 = None if observed_motion is None else torch.concatenate([observed_motion]*3, dim=0)
    fh3 = None if first_heading_angle is None else torch.concatenate([first_heading_angle]*3, dim=0)
    pm3 = torch.concatenate([pad_mask]*3, dim=0)
    tm3 = torch.concatenate([text_pad_mask, False*text_pad_mask, False*text_pad_mask], dim=0)
    net = self.denoiser.model
    for i in reversed(range(n)):
        t = torch.full((B,), i, dtype=torch.long, device=dev); tmap = map_t[t]
        out = net(torch.concatenate([cur, cur, cur], dim=0), pm3, tf3, tm3, torch.concatenate([tmap, tmap, tmap], dim=0),
                  first_heading_angle=fh3, motion_mask=mm3, observed_motion=ob3)
        o_text, o_con, o_unc = torch.chunk(out, 3)
        pred = o_unc+(w0*(o_text-o_unc))+(w1*(o_con-o_unc))
        eps = (sra[t, None, None]*cur-pred)/srm1[t, None, None]
        abp = acp[t, None, None]
        cur = pred*torch.sqrt(abp)+torch.sqrt(1-abp)*eps
    return cur


def patch_denoiser(model, half, fast_sampler):
    """half 'fp16' casts both transformer stages; fast_sampler replaces model._generate with _generate_fast and drops
    the stages' all-False padding mask."""
    net = model.denoiser.model
    forward = _forward_unmasked if fast_sampler else TransformerEncoderBlock.forward
    for block in (net.root_model, net.body_model):
        if fast_sampler:
            assert not block.use_text_mask, 'the unmasked forward needs use_text_mask off'
        if half == 'fp16':
            for part in HALF_PARTS:
                getattr(block, part).to(torch.float16)
            block.forward = functools.partial(_half_forward, block, forward)
        elif fast_sampler:
            block.forward = functools.partial(forward, block)
    if fast_sampler:
        model._generate = functools.partial(_generate_fast, model, {})


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 24), b''):
            h.update(chunk)
    return h.hexdigest()


def qwen_paths():
    """(Qwen3-8B directory, projection safetensors) named by MOTION_QWEN and MOTION_QWEN_PROJECTION."""
    return Path(os.environ['MOTION_QWEN']), Path(os.environ['MOTION_QWEN_PROJECTION'])


def base_checkpoint():
    """The Kimodo weights load_model reads under CHECKPOINT_DIR."""
    return Path(os.environ['CHECKPOINT_DIR'])/MODEL/'model.safetensors'


def lora_delta(A, B, scale):
    """scale·[B_q A_q; B_k A_k; B_v A_v] for an in_proj_weight [3d, d]; A [3, r, d], B [3, d, r]."""
    return scale*torch.bmm(B, A).reshape(-1, A.shape[-1])


def read_lora(path, base_sha256):
    """(config, tensors '<layer>.A'/'<layer>.B', file sha256) of a lora.pt; refuses one trained on other base weights."""
    data = Path(path).read_bytes()
    lora = torch.load(io.BytesIO(data), map_location='cpu', weights_only=True)
    config = lora['config']
    if config['base_sha256'] != base_sha256:
        raise ValueError(f'{path} was trained on base checkpoint sha256 {config["base_sha256"]}, these weights are {base_sha256}')
    return config, lora['tensors'], hashlib.sha256(data).hexdigest()


def lora_key(entry):
    """Prefix of an entry's '.A'/'.B' tensors: '<module>' for qkv (as lora.pt before entries), else '<module>.<param>'."""
    return entry['module'] if entry['kind'] == 'qkv' else f'{entry["module"]}.{entry["param"]}'


def merge_lora(net, config, tensors):
    """W + (alpha/rank)·B·A into each entry's weight of net; a config without entries has the qkv of its layers."""
    scale = config['alpha']/config['rank']
    entries = config.get('entries') or [{'module': layer, 'param': 'in_proj_weight', 'kind': 'qkv'} for layer in config['layers']]
    with torch.no_grad():
        for e in entries:
            w, key = getattr(net.get_submodule(e['module']), e['param']), lora_key(e)
            A, B = tensors[key+'.A'].to(w), tensors[key+'.B'].to(w)
            w.add_(lora_delta(A, B, scale) if e['kind'] == 'qkv' else scale*(B@A))


def vocab_rows(qwen_dir):
    """A slice over Qwen's embed_tokens.weight in its mmap'd safetensors shard; rows read on demand."""
    index = json.loads((qwen_dir/'model.safetensors.index.json').read_text())['weight_map']
    key = next(k for k in index if k.endswith('embed_tokens.weight'))
    return safe_open(str(qwen_dir/index[key]), 'pt', device='cpu').get_slice(key)


class KimodoBackend:
    model_name = MODEL

    def __init__(self, device='cuda', half='none', fast_sampler=False, mmap_vocab=False, warm_prompts=(), lora=None):
        self.device = self.dev = device
        self.half, self.fast_sampler = half, fast_sampler
        self.cache = {}
        if device == 'mps':
            # MPS has no float64: load on CPU, cast the float64 buffers (neutral joints, normalization stats), then move.
            self.model = load_model(MODEL, device='cpu', text_encoder=NoText())
            for module in self.model.modules():
                for k, b in list(module._buffers.items()):
                    if b is not None and b.dtype == torch.float64:
                        module._buffers[k] = b.float()
            self.model.to(device); self.model.device = device
        else:
            self.model = load_model(MODEL, device=device, text_encoder=NoText())
        self.lora = None  # {'name', 'sha256'} of the merged LoRA
        if lora is not None:
            config, tensors, sha256 = read_lora(lora, file_sha256(base_checkpoint()))
            merge_lora(self.model.denoiser.model, config, tensors)  # before patch_denoiser casts to fp16
            self.lora = {'name': config['name'], 'sha256': sha256}
        patch_denoiser(self.model, half, fast_sampler)
        self.sk = self.model.skeleton
        qwen, projection = qwen_paths()
        self.tok = AutoTokenizer.from_pretrained(qwen); self.tok.padding_side = 'left'
        if self.tok.pad_token is None: self.tok.pad_token = self.tok.eos_token
        self.qwen = AutoModel.from_pretrained(qwen, dtype=torch.bfloat16, use_safetensors=True, trust_remote_code=False)
        self.vocab = vocab_rows(qwen) if mmap_vocab else None
        if mmap_vocab:  # dropped before the move, so the table never reaches the device
            self.qwen.embed_tokens.weight.data = torch.empty(0, TEXT_DIM, dtype=torch.bfloat16)
        self.qwen = self.qwen.to(device).eval()
        sd = load_file(str(projection)); self.proj = torch.nn.Linear(sd['weight'].shape[1], sd['weight'].shape[0]).to(device).eval()
        self.proj.load_state_dict(sd)
        self._reference()
        with torch.inference_mode():
            for prompt in warm_prompts:
                self._encode(prompt)
        self.warm_prompts = len(warm_prompts)

    def _reference(self):
        """Effector reference pose and the skeleton document, from self.model on self.dev."""
        sk, device = self.sk, self.dev
        # Effector reference pose: the public right-hand example's first frame with its root over the origin (gen_geom.py).
        ref = next(c for c in cs.load_constraints_lst(str(EXAMPLE), sk) if c.name == 'right-hand')
        pos = ref.global_joints_positions[:1].to(device).float().clone(); rot = ref.global_joints_rots[:1].to(device).float().clone()
        shift = pos[:, sk.root_idx].clone(); shift[:, 1] = 0
        self.ref_pos, self.ref_rot = pos-shift[:, None], rot
        hv = cs.compute_global_heading(self.ref_pos, sk)[0]; self.ref_heading = float(torch.atan2(hv[1], hv[0]))
        self.skeleton = {'name': sk.name, 'names': list(sk.bone_order_names), 'parents': sk.joint_parents.cpu().tolist(),
                         'neutral_joints': sk.neutral_joints.cpu().tolist(), 'root_idx': sk.root_idx, 'foot_indices': list(sk.foot_joint_idx),
                         'hand_index': sk.bone_index[sk.right_hand_joint_names[0]]}

    def _move(self, c):
        for k, v in vars(c).items():
            if torch.is_tensor(v): setattr(c, k, v.to(self.dev))
        return c

    def _encode(self, prompt):
        if prompt in self.cache:
            return self.cache[prompt]
        x = self.tok([prompt], return_tensors='pt', truncation=True, max_length=512)
        if self.vocab is None:
            x = x.to(self.dev); h = self.qwen(**x).last_hidden_state
        else:
            rows = torch.cat([self.vocab[i:i+1] for i in x['input_ids'][0].tolist()])[None].to(self.dev)
            x = x.to(self.dev); h = self.qwen(inputs_embeds=rows, attention_mask=x['attention_mask']).last_hidden_state
        m = x['attention_mask'].unsqueeze(-1).to(h.dtype)
        feat = self.proj(((h*m).sum(1)/m.sum(1).clamp(min=1e-9)).float())
        if len(self.cache) >= CACHE:
            del self.cache[next(iter(self.cache))]
        self.cache[prompt] = feat
        return feat

    def _root(self, root):
        sets = []
        for keys in ([k for k in root if k['yaw'] is not None], [k for k in root if k['yaw'] is None]):
            if not keys: continue
            heading = torch.tensor([[math.cos(k['yaw']), math.sin(k['yaw'])] for k in keys], device=self.dev) if keys[0]['yaw'] is not None else None
            sets.append(self._move(cs.Root2DConstraintSet(self.sk, torch.tensor([k['frame'] for k in keys], device=self.dev),
                torch.tensor([[k['x'], k['z']] for k in keys], dtype=torch.float32, device=self.dev), global_root_heading=heading)))
        return sets

    @staticmethod
    def _placement(root, frame):
        """Root (x, z, heading) at frame, linear between the root keys; the origin facing heading 0 without keys."""
        keys = sorted(root, key=lambda k: k['frame']); turns = [k for k in keys if k['yaw'] is not None]
        x = np.interp(frame, [k['frame'] for k in keys], [k['x'] for k in keys]) if keys else 0.
        z = np.interp(frame, [k['frame'] for k in keys], [k['z'] for k in keys]) if keys else 0.
        yaw = np.interp(frame, [k['frame'] for k in turns], [k['yaw'] for k in turns]) if turns else 0.
        return float(x), float(z), float(yaw)

    def _effector(self, effector, root):
        """End-effector constraint from the reference pose placed at the root and bent to reach the target (gen_geom.py)."""
        sk, dev, joint, frame = self.sk, self.dev, effector['joint'], effector['frame']
        x, z, yaw = self._placement(root, frame)
        R = yaw_rotation(yaw-self.ref_heading, dev)
        pos = self.ref_pos @ R.T+torch.tensor([x, 0, z], device=dev); rot = R @ self.ref_rot
        target = torch.tensor(effector['pos'], dtype=torch.float32, device=dev)
        if joint == 'Hips':
            pos = pos-pos[:, sk.root_idx:sk.root_idx+1]+target
        else:
            a, b, c = (sk.bone_index[n] for n in LIMBS[joint])
            a0, b0, c0 = pos[0, a], pos[0, b], pos[0, c]; l1 = torch.linalg.norm(b0-a0); l2 = torch.linalg.norm(c0-b0)
            d = target-a0; dist = torch.linalg.norm(d)
            if not abs(float(l1-l2)) < float(dist) <= float(l1+l2):
                raise ValueError(f'{joint} target at frame {frame} is out of reach: {float(dist):.3f} m from {LIMBS[joint][0]}, limb {float(l1+l2):.3f} m')
            d = d/dist
            along = (l1*l1-l2*l2+dist*dist)/(2*dist); height = torch.sqrt((l1*l1-along*along).clamp_min(0))
            # Bend in the reference limb's own plane: the middle joint's offset from the upper-to-end line.
            line = (c0-a0)/torch.linalg.norm(c0-a0); bend = b0-a0-line*torch.dot(b0-a0, line)
            hint = bend-d*torch.dot(bend, d); hint = hint/torch.linalg.norm(hint); middle = a0+d*along+hint*height
            trot = rot.clone(); trot[0, a] = swing(b0-a0, middle-a0) @ rot[0, a]; trot[0, b] = swing(c0-b0, target-middle) @ rot[0, b]
            rot, pos, _ = sk.fk(sk.global_rots_to_local_rots(trot), pos[:, sk.root_idx])
            assert torch.linalg.norm(pos[0, c]-target) < 1e-4, 'reference FK must reproduce the effector target'
        return self._move(cs.EndEffectorConstraintSet(sk, torch.tensor([frame], device=dev), pos, rot, None, joint_names=[joint]))

    def generate(self, prompt, frames, seed, steps, root, effectors):
        """(native SOMA-30 arrays with B=1, encode ms, generate ms)."""
        m, dev = self.model, self.dev
        with torch.inference_mode():
            constraints = self._root(root)+[self._effector(e, root) for e in effectors]
            sync(dev); t0 = time.perf_counter()
            text = prompt.strip()
            feat = self._encode(text)[:, None] if text else torch.zeros(1, 1, TEXT_DIM, device=dev)
            sync(dev); t1 = time.perf_counter()
            obs, mask = m.motion_rep.create_conditions_from_constraints_batched(
                [constraints], torch.tensor([frames], device=dev), to_normalize=True, device=dev) if constraints else (None, None)
            torch.manual_seed(seed)
            motion = m._generate([''], frames, steps, torch.ones(1, frames, device=dev, dtype=torch.bool), torch.zeros(1, device=dev), mask, obs,
                                 cfg_weight=[2., 2.] if text else [0., 2.], cfg_type='separated', text_feat=feat,
                                 text_pad_mask=torch.full((1, 1), bool(text), device=dev), progress_bar=lambda x: x)
            out = m.motion_rep.inverse(motion, is_normalized=True, return_numpy=False)
            sync(dev); t2 = time.perf_counter()
        arrays = {k: (v.float() if v.is_floating_point() else v).cpu().numpy() for k, v in out.items() if torch.is_tensor(v)}
        return arrays, (t1-t0)*1e3, (t2-t1)*1e3
