#!/usr/bin/env python3
"""The motion graph of a built C7 pack (animation/motion-graph.json): every clip of its actor archive, where the
runtime plays it, every switch the runtime makes between clips, and the chain the runtime walks from each start.

A chain is ActorMotionPolicy.chain: from a clip to its source auto-return, else its next, until a clip repeats; a held
loop's exit chain follows it. A gap is pose_family.gap_cm between the pose a clip is left from (a loop's first frame,
else its last) and the first frame of the clip it enters. Families and runtime gaps are the pack's pose-families.json;
a clip that file lacks is measured here the same way. Runtime constants are the native runtime's, listed in RUNTIME.

    python3 -I characters/build.py motion_graph --catalog LIBRARY/current.json --character ID --output FILE
    python3 -I characters/build.py motion_graph --catalog LIBRARY/current.json --output NEW_DIR

The second writes NEW_DIR/library: the library with every character pack's graph (re)written and registered.
"""
import argparse
import json
import re
import shutil
import tempfile
from collections import defaultdict
from pathlib import Path

from character_library import Library, Package, need, read_json, write_json
import native_bundle
from resource_store import clone_or_copy
from .common import reference
from .mmd.rig_math import pack_humanoid
from .pose_family import Poses, gap_cm, nearest


def read(path): return json.loads(Path(path).read_text(encoding='utf-8-sig'))


SCHEMA = 'endfield-motion-graph/v1'
FILE = 'motion-graph.json'
# Bytes of the written document (indent 2, as pack data files are written).
MAX_BYTES = 4 << 20
# Pack data files the graph reads; any may be absent.
DOCUMENTS = [('animation', n) for n in ['intent-motion-map.json', 'motion-bindings.json', 'pose-families.json', 'supplemental-clips.json',
                                         'actions.json', 'motion-media.json']] + \
            [('interaction', n) for n in ['motion-metadata.json', 'blend-times.json', 'affordance-uses.json', 'actions.json', 'locomotion.json',
                                           'directional-locomotion.json', 'pose-scenes.json', 'composites.json']]
# Values the native runtime hard-codes: {name: (value, where)}.
RUNTIME = dict(
    blend_curve=([[8.0, 0.25], [25.0, 0.6], [40.0, 0.9], [55.0, 0.9], [75.0, 1.2]], 'ActorPoseFamilies.blendCurve'),
    excluded_families=(['boss', 'other'], 'ActorPoseFamilies.excluded'),
    lifted_postures=(['air', 'boss'], 'ActorMotionPolicy.liftedPostures'),
    intents=(['idle', 'listen', 'think', 'speak', 'greet', 'acknowledge', 'explain', 'offer', 'uncertain', 'reassure', 'celebrate', 'apologize'],
             'ActorMotionController.intents'),
    urgent_events=(['session.approval', 'session.input', 'session.error'], 'ActorMotionController.urgentEvents'),
    seat_blend_s=(0.25, 'HostSeat blend'),
    seat_off_loop_return_blend_s=(0.8, 'HostSeat offLoopReturnBlend'),
    seat_detour_hold_s=([8.0, 20.0], 'HostSeat hold'),
    window_seat_fade_s=(0.2, 'HostWindowSeat.fadeSeconds'),
)
DEFAULT_SEAT_REDRAW_CM, DEFAULT_SEAT_VARIANT_HOLD_S = 55.0, 20.0
SESSION_GROUPS = ['session.thinking', 'session.tool', 'session.subagent', 'session.approval', 'session.input', 'session.done', 'session.error']
GROUPS = [
    ('base', '基础站姿与桥接', None),
    ('session.thinking', '思考', 'session'), ('session.tool', '用工具', 'session'), ('session.subagent', '子 agent', 'session'),
    ('session.approval', '等你批准', 'session'), ('session.input', '等你输入', 'session'), ('session.done', '完成', 'session'),
    ('session.error', '出错', 'session'),
    ('click', '点击与进场', None), ('idle', '空闲各档', None), ('speech', '说话手势', None), ('seat', '坐下与座位', None),
    ('rest', '休息', None), ('unwired', '包里有但没接到任何地方的片段', None),
]
POOL_TYPES = {'event', 'tier', 'activity', 'speech', 'intent', 'fidget', 'click_reaction', 'point', 'idle_variant', 'seat', 'chain',
              'base', 'bridge', 'binding'}
# Archive clip curve_provenance kinds a clip's origin reads: import_vmd.encode_clip and motion_import.bake.KIND write the
# imported ones, import_generated.KIND the generated; every other kind is the game's own frames (or a retarget of another
# character's). A window takes its source clip's origin.
IMPORTED_KINDS = {'external-vmd-retargeted-linear-samples', 'humanoid-retargeted-linear-samples'}
GENERATED_KINDS = {'kimodo-soma-retargeted-linear-samples'}
ACTIVITY_GROUP = {'relax': 'rest', 'sleep': 'rest', 'yawn': 'rest', 'fidget': 'idle', 'think': 'session.thinking',
                  'wait': 'speech', 'react': 'speech', 'welcome_back': 'click', 'seat': 'seat'}


def r3(x):
    return None if x is None else round(float(x), 3)


def r1(x):
    return None if x is None else round(float(x), 1)


def policy_chain(start, next_clip):
    """ActorMotionPolicy.chain: `start`, then next_clip of each clip, until none or a repeat."""
    out, c, seen = [], start, set()
    while c and c not in seen:
        seen.add(c)
        out.append(c)
        c = next_clip(c)
    return out


def graph(character, documents, clips, rig, ends, meta=None, unmeasured=(), previous=None, humanoid=None):
    """The motion-graph document.

    documents: {'<section>/<file>': document or None} of DOCUMENTS, and 'palette' the pack's palette contract;
    clips: {name: archive clip row (length, loop)}; rig: the archive's rig document; ends: {clip: (rotations,
    positions, scales|None)} local TRS of its first and last frame; meta: {clip: archive clip document};
    unmeasured: clips whose frames could not be read; previous: an earlier graph of the same clip frames, whose poses
    and measured families stand in for ends; humanoid: the pack's humanoid.json document, as Poses takes it."""
    meta = meta or {}
    doc = lambda key, empty=None: documents.get(key) or empty
    unmapped = [f'{n}: pose not measurable' for n in unmeasured]

    def note(text):
        if text not in unmapped:
            unmapped.append(text)

    im = doc('animation/intent-motion-map.json')
    bindings = doc('animation/motion-bindings.json')
    pf = doc('animation/pose-families.json')
    metadata = doc('interaction/motion-metadata.json', {'clips': {}})['clips']
    blend_in = dict(doc('interaction/blend-times.json', {'clips': {}})['clips'])
    affordance = doc('interaction/affordance-uses.json', {'uses': []})
    actions = doc('animation/actions.json', {'actions': []})['actions'] + doc('interaction/actions.json', {'actions': []})['actions']
    rules = {r['name']: r for r in doc('palette', {'clips': []})['clips']}
    for r in doc('animation/supplemental-clips.json', {'clips': []})['clips']:
        rules[r['name']] = r
    entries = dict(im['clips'])
    ordered = list(im['clips'])
    # The runtime refuses a map without crossfade_seconds; a partial plan's map gets native_pack's .25.
    crossfade = float(im.get('crossfade_seconds', .25))
    all_clips = list(clips)

    K = {k: dict(value=v, source=s) for k, (v, s) in RUNTIME.items()}
    K['seat_redraw_cm'] = dict(value=im['seat_redraw_cm'], source='intent-motion-map seat_redraw_cm') if im.get('seat_redraw_cm') is not None \
        else dict(value=DEFAULT_SEAT_REDRAW_CM, source='ActorMotionPolicy.defaultSeatRedrawCm')
    K['seat_variant_hold_s'] = dict(value=im['seat_variant_hold_s'], source='intent-motion-map seat_variant_hold_s') \
        if im.get('seat_variant_hold_s') is not None else dict(value=DEFAULT_SEAT_VARIANT_HOLD_S, source='ActorMotionPolicy.defaultSeatVariantHoldS')
    curve = K['blend_curve']['value']
    seamless = curve[0][0]
    excluded_set = set(K['excluded_families']['value'])
    lifted = set(K['lifted_postures']['value'])
    intents_known = set(K['intents']['value'])
    seat_blend, off_loop_blend = K['seat_blend_s']['value'], K['seat_off_loop_return_blend_s']['value']
    detour_hold, window_fade = K['seat_detour_hold_s']['value'], K['window_seat_fade_s']['value']

    def blend_seconds(gap):
        if gap <= curve[0][0]:
            return curve[0][1]
        for (ac, asec), (bc, bsec) in zip(curve, curve[1:]):
            if gap <= bc:
                return asec + (bsec - asec) * (gap - ac) / (bc - ac)
        return curve[-1][1]

    # ---- poses and families ----
    if previous is None:
        poses = Poses(rig, humanoid) if ends else None
        pose_ends = {n: poses.endpoints(*v) for n, v in ends.items()}
    else:
        # A graph keeps no stances, so its clips' measured families are taken as they are below.
        pose_ends = {n: tuple((None, [[x / 100 for x in p] for p in e[k]]) for k in ['start', 'end'])
                     for n, e in previous['poses'].items() if n in clips}
        previous_families = {c['name']: c['family'] for c in previous['clips'] if c.get('family', {}).get('measured_here')}
    fam_bases = dict((pf or {}).get('bases') or {})
    base_clip_family = {c: f for f, c in fam_bases.items()}
    hub = (pf or {}).get('hub')
    bridges = dict((pf or {}).get('bridges') or {})
    references = dict((pf or {}).get('references') or {})
    family_gaps = (pf or {}).get('family_gaps_cm') or {}
    file_rows = (pf or {}).get('clips') or {}
    fam_rows = {n: dict(file_rows[n], measured=False) for n in all_clips if n in file_rows}
    named = dict(fam_bases, **references)
    if pf and set(named.values()) <= set(pose_ends):
        first = {f: pose_ends[c][0] for f, c in named.items()}
        for n in all_clips:
            if n in file_rows or n not in pose_ends:
                continue
            if previous is None:
                (s, s_cm), (e, e_cm) = (nearest(x, first) for x in pose_ends[n])
                fam_rows[n] = dict(start=s, end=e, start_cm=s_cm, end_cm=e_cm, measured=True)
            elif n in previous_families:
                f = previous_families[n]
                fam_rows[n] = dict(start=f['start'], end=f['end'], start_cm=f['start_cm'], end_cm=f['end_cm'], measured=True)
    elif pf:
        note('pose-families bases not measurable; clips it lacks have no family')

    # ---- runtime model ----
    def loops(c):
        r = rules.get(c)
        if r is not None and 'loop' in r:
            return bool(r['loop'])
        return bool(clips.get(c, {}).get('loop'))

    def length(c):
        return float(clips[c]['length']) if c in clips else None

    def eff_blend(c, fallback):
        b = blend_in.get(c)
        return float(b['blend_in_s']) if b else fallback

    returns = {n: r['auto_return_clip'] for n, r in rules.items() if r.get('auto_return_clip')}

    def next_clip(c):
        return returns.get(c) or (entries.get(c) or {}).get('next')

    def chain(start):
        return policy_chain(start, next_clip)

    def held(c):
        return (entries.get(c) or {}).get('hold_policy') == 'while_requested'

    def requested_loop(start):
        return next((c for c in chain(start) if held(c)), None)

    def last(c):
        x, seen = c, set()
        while x not in seen:
            seen.add(x)
            e = entries.get(x) or {}
            n = returns.get(x) or e.get('next') or e.get('exit')
            if not n:
                break
            x = n
        return x

    postures = {'stand', 'sit', 'floor', 'lie'} | lifted

    def posture(c):
        s = (metadata.get(c) or {}).get('stance_end', 'stand')
        return s if s in postures else 'stand'

    def stance_start(c):
        return (metadata.get(c) or {}).get('stance_start', 'stand')

    # Runtime pose-family view (ActorPoseFamilies): only what the pack's pose-families.json says.
    def fam_of(c):
        return base_clip_family.get(c) or (file_rows.get(c) or {}).get('end')

    def start_fam(c):
        return base_clip_family.get(c) or (file_rows.get(c) or {}).get('start')

    def runtime_gap(frm, to):
        a, b = fam_of(frm), start_fam(to)
        if a is None or b is None:
            return None
        end = 0 if frm in base_clip_family else (file_rows.get(frm) or {}).get('end_cm', 0)
        start = 0 if to in base_clip_family else (file_rows.get(to) or {}).get('start_cm', 0)
        if a == b:
            return end + start if a in fam_bases else None
        g = (family_gaps.get(a) or {}).get(b)
        if g is None:
            g = (family_gaps.get(b) or {}).get(a)
        if g is not None:
            return g
        xs = [v for v in [end if a not in fam_bases else None, start if b not in fam_bases else None] if v is not None]
        return max(xs) if xs else None

    def redraw_gap(loop, clip):
        xs = [g for g in [runtime_gap(loop, clip), runtime_gap(clip, loop)] if g is not None]
        return max(xs) if xs else None

    def measured_gap(frm, to):
        if frm not in pose_ends or to not in pose_ends:
            note(f'gap {frm} > {to} not measurable')
            return None
        return round(gap_cm(pose_ends[frm][0 if loops(frm) else 1][1], pose_ends[to][0][1]), 1)

    hub_clip = fam_bases.get(hub) if hub else (bindings or {}).get('overview')
    relax_clip = (bindings or {}).get('relax') or fam_bases.get('relax')
    idle_bases = [c for c in dict.fromkeys([hub_clip, relax_clip]) if c]

    # library contexts (reviewed motion_library), in file order
    ml = im.get('motion_library') or {}
    contexts = defaultdict(list)
    for c, e in ml.items():
        if e.get('reviewed'):
            for ctx in dict.fromkeys(e.get('contexts') or []):
                contexts[ctx].append(c)

    def weight(c, ctx):
        e = ml.get(c) or {}
        w = (e.get('context_weights') or {}).get(ctx)
        return w if w is not None else e.get('weight', 1)

    events = im.get('events') or {}
    tiers = im.get('idle_tiers') or []
    activities = im.get('activities') or {}
    speech = im.get('speech_gestures') or {}
    fidget = im.get('idle_fidget') or {}

    # Standing and lifted pool clips the runtime never draws: start or chain rest in an excluded family, with no unbridged reason.
    pooled = set(c for v in contexts.values() for c in v)
    pooled |= {p['clip'] for e in events.values() for p in e['pool']}
    pooled |= {p['clip'] for t in tiers for p in t['pool']}
    pooled |= set(fidget.get('clips') or []) | set(speech.get('clips') or []) | set(im.get('click_reactions') or [])
    pooled |= {c for lists in activities.values() for l in lists.values() for c in l}
    excluded = {}
    for c in sorted(pooled):
        st = stance_start(c)
        if st in postures and st != 'stand' and st not in lifted or (ml.get(c) or {}).get('unbridged'):
            continue
        s = (file_rows.get(c) or {}).get('start')
        if s is None:
            continue
        fam = next((f for f in [s, (file_rows.get(last(c)) or {}).get('end')] if f in excluded_set), None)
        if fam:
            excluded[c] = fam

    tier_postures = []
    for t in tiers:
        hs = {x for p in t['pool'] for x in (stance_start(p['clip']), posture(p['clip']))}
        tier_postures.append(t.get('stance') or (next(iter(hs)) if len(hs) == 1 and next(iter(hs)) in postures else 'stand'))

    # ---- uses ----
    uses = defaultdict(list)

    def add(clip, **u):
        u.setdefault('active', True)
        u = {k: v for k, v in u.items() if v is not None}
        if 'mood' in u:
            mood = u.pop('mood')
            for x in uses[clip]:
                if {k: v for k, v in x.items() if k != 'moods'} == u:
                    x['moods'].append(mood)
                    return
            u['moods'] = [mood]
        if u not in uses[clip]:
            uses[clip].append(u)

    def group_of_event(name):
        if name.startswith('session.'):
            return name if name in SESSION_GROUPS else 'session.thinking'
        if name.startswith(('click.', 'drag.', 'character.', 'point')):
            return 'click'
        if name.startswith('rest.'):
            return 'rest'
        return 'idle'

    seat_loops = defaultdict(list)  # posture -> [(loop, 'host'|'held', seat use id)]
    # HostSeat (surface 'seat') draws posture pools at its loop's boundaries; HostWindowSeat only holds its loop.
    for u in affordance['uses']:
        if u.get('surface') == 'seat':
            seat_loops[posture(u['loop'])].append((u['loop'], 'host', u['id']))
    for c, e in entries.items():
        if held(c) and posture(c) != 'stand' and c in clips and c not in [l for v in seat_loops.values() for l, _, _ in v]:
            seat_loops[posture(c)].append((c, 'held', None))

    for key, e in events.items():
        name, _, pst = key.partition('@')
        pst = pst or 'stand'
        grp = group_of_event(name)
        # ActorMotionController.playClickReaction reads click.single and the region pools from events; click.repeat goes through playEvent.
        if name.startswith('click.') and name != 'click.repeat':
            effective = [(p['clip'], p.get('weight', 1), 'events') for p in e['pool']]
            for c in contexts.get(key, []):
                add(c, type='event', key=key, group=grp, via='motion_library', active=False,
                    reason=f'{name} 只从 events 池抽（playClickReaction）')
        elif contexts.get(key):
            effective = [(c, weight(c, key), 'motion_library') for c in contexts[key]]
            for p in e['pool']:
                if p['clip'] not in contexts[key]:
                    add(p['clip'], type='event', key=key, group=grp, via='events', weight=p.get('weight', 1), active=False,
                        reason=f'motion_library 的 {key} 覆盖了 events 池')
        else:
            effective = [(p['clip'], p.get('weight', 1), 'events') for p in e['pool']]
        for c, w, via in effective:
            u = dict(type='event', key=key, group=grp, via=via, weight=w, cooldown_s=e.get('cooldown_s'), interrupt=e.get('interrupt'),
                     repick_gap_s=e.get('repick_gap_s'), no_repeat=e.get('no_repeat'), posture=pst if pst != 'stand' else None)
            if not w:
                u.update(active=False, reason='权重 0')
            elif c in excluded:
                u.update(active=False, reason=f'起始或收尾在 {excluded[c]} 族，运行时不会抽到')
            elif pst != 'stand':
                loops_here = []
                for loop, kind, use_id in seat_loops.get(pst, []):
                    ok = requested_loop(c) is None
                    loops_here.append(dict(loop=loop, drawn=ok, gap_cm=r1(redraw_gap(loop, c)), seat=use_id))
                u['loops'] = loops_here
                if not any(x['drawn'] for x in loops_here):
                    u.update(active=False, reason=f'没有能抽到它的 {pst} 循环')
            add(c, **u)
    for ctx, cs in contexts.items():
        if ctx.startswith(('session.', 'click.', 'drag.', 'character.', 'rest.')) and ctx not in events:
            for c in cs:
                add(c, type='event', key=ctx, group=group_of_event(ctx.partition('@')[0]), via='motion_library', active=False,
                    reason=f'events 里没有 {ctx}')

    for i, t in enumerate(tiers):
        ctx = f'idle.t{i + 1}'
        pst = tier_postures[i]
        if contexts.get(ctx):
            effective = [(c, weight(c, ctx), 'motion_library') for c in contexts[ctx]]
            for p in t['pool']:
                if p['clip'] not in contexts[ctx]:
                    add(p['clip'], type='tier', key=ctx, group='idle', via='idle_tiers', active=False, reason=f'motion_library 的 {ctx} 覆盖了档位池')
        else:
            effective = [(p['clip'], p.get('weight', 1), 'idle_tiers') for p in t['pool']]
        for c, w, via in effective:
            u = dict(type='tier', key=ctx, group='idle', via=via, weight=w, after_s=t.get('after_s'), interval_s=t.get('interval_s') or t.get('after_s'),
                     no_repeat=t.get('no_repeat'), min_gap_s=(t.get('min_gap_s') or {}).get(c), stance=pst)
            if not w:
                u.update(active=False, reason='权重 0')
            elif c in excluded:
                u.update(active=False, reason=f'起始或收尾在 {excluded[c]} 族，运行时不会抽到')
            elif pst != 'stand':
                loops_here = []
                # HostSeat draws a seated tier at its seat loop; a held air or boss loop draws its own posture's tier.
                for loop, kind, use_id in seat_loops.get(pst, []):
                    ok = (kind == 'host' or pst in lifted) and requested_loop(c) is None and stance_start(c) == pst and posture(c) == pst
                    loops_here.append(dict(loop=loop, drawn=ok, gap_cm=r1(redraw_gap(loop, c)), seat=use_id))
                u['loops'] = loops_here
                if not any(x['drawn'] for x in loops_here):
                    u.update(active=False, reason=f'没有能抽到它的 {pst} 座位循环')
            add(c, **u)
    for ctx in contexts:
        m = re.fullmatch(r'idle\.t(\d+)', ctx)
        if m and int(m.group(1)) > len(tiers):
            for c in contexts[ctx]:
                add(c, type='tier', key=ctx, group='idle', via='motion_library', active=False, reason=f'idle_tiers 没有第 {m.group(1)} 档')

    for name, lists in activities.items():
        ctx = 'activity.' + name
        grp = ACTIVITY_GROUP.get(name, 'idle')
        lib_ctx = contexts.get(ctx, [])
        for mood, cs in lists.items():
            for c in cs:
                active = bool(requested_loop(c)) or not lib_ctx
                add(c, type='activity', key=name, mood=mood, group=grp, via='activities', active=active,
                    held=bool(requested_loop(c)) or None,
                    reason=None if active else f'motion_library 的 {ctx} 覆盖了这个一次性列表')
        explicit_held = any(requested_loop(c) for cs in lists.values() for c in cs)
        for c in lib_ctx:
            active = not (requested_loop(c) and explicit_held)
            add(c, type='activity', key=name, group=grp, via='motion_library', weight=weight(c, ctx), active=active,
                reason=None if active else f'activities.{name} 自己的持续动作优先')
    for ctx, cs in contexts.items():
        if ctx.startswith('activity.') and ctx[len('activity.'):] not in activities:
            for c in cs:
                add(c, type='activity', key=ctx[len('activity.'):], group=ACTIVITY_GROUP.get(ctx[len('activity.'):], 'idle'),
                    via='motion_library', active=False, reason=f'intent-motion-map 没有 activities.{ctx[len("activity."):]}，运行时不读')

    if contexts.get('speech.gesture'):
        for c in contexts['speech.gesture']:
            add(c, type='speech', key='speech.gesture', group='speech', via='motion_library', weight=weight(c, 'speech.gesture'),
                interval_s=speech.get('interval_seconds'))
        for c in speech.get('clips') or []:
            if c not in contexts['speech.gesture']:
                add(c, type='speech', key='speech_gestures', group='speech', via='speech_gestures', active=False,
                    reason='motion_library 的 speech.gesture 覆盖了它')
    else:
        for c in speech.get('clips') or []:
            add(c, type='speech', key='speech_gestures', group='speech', via='speech_gestures', interval_s=speech.get('interval_seconds'))

    for c in ordered:
        for it in (entries.get(c) or {}).get('intents') or []:
            primary = next(x for x in ordered if it in ((entries.get(x) or {}).get('intents') or []))
            if c != primary:
                add(c, type='intent', key=it, group='speech', via='clips.intents', active=False, reason=f'{it} 的首个片段是 {primary}')
            elif requested_loop(c):
                add(c, type='intent', key=it, group='speech', via='clips.intents', held=True, stroke_s=entries[c].get('stroke_s'))
            elif contexts.get('intent.' + it):
                add(c, type='intent', key=it, group='speech', via='clips.intents', active=False,
                    reason=f'motion_library 的 intent.{it} 覆盖了它（clause gestures 打开时才用它）')
            else:
                add(c, type='intent', key=it, group='speech', via='clips.intents', stroke_s=entries[c].get('stroke_s'))
    for ctx, cs in contexts.items():
        if ctx.startswith('intent.'):
            it = ctx[len('intent.'):]
            primary = next((x for x in ordered if it in ((entries.get(x) or {}).get('intents') or [])), None)
            for c in cs:
                if it not in intents_known:
                    add(c, type='intent', key=it, group='speech', via='motion_library', active=False, reason=f'运行时不认识意图 {it}')
                elif primary and requested_loop(primary):
                    add(c, type='intent', key=it, group='speech', via='motion_library', active=False, reason=f'{primary} 是持续动作，优先')
                else:
                    add(c, type='intent', key=it, group='speech', via='motion_library', weight=weight(c, ctx))

    for c in fidget.get('clips') or []:
        add(c, type='fidget', key='idle_fidget', group='idle', interval_s=fidget.get('interval_seconds'), active=not tiers,
            reason='有 idle_tiers 时运行时不用 idle_fidget' if tiers else None)
    for c in im.get('click_reactions') or []:
        add(c, type='click_reaction', key='click_reactions', group='click', active='click.single' not in events,
            reason='有 events.click.single 时运行时不用 click_reactions' if 'click.single' in events else None)
    if im.get('point_clip'):
        add(im['point_clip'], type='point', key='point_clip', group='click')

    for c, e in entries.items():
        for v in e.get('idle_variants') or []:
            add(v, type='idle_variant', key=c, group='rest', interval_s=e.get('idle_interval_s'), weight=weight(v, 'activity.relax'))

    for u in affordance['uses']:
        for role in ('enter', 'loop', 'exit'):
            if u.get(role):
                add(u[role], type='seat', key=u['id'], role=role, group='seat', surface=u.get('surface'), enter_style=u.get('enter_style'))
        for v in u.get('variants') or []:
            ok, reason = True, None
            if u.get('surface') != 'seat':
                ok, reason = False, f'{u.get("surface")} 座位只播它的循环，不播变体'
            add(v['clip'], type='seat', key=u['id'], role='variant', variant=v['id'], group='seat', after_loop_s=v.get('after_loop_s'),
                cooldown_s=v.get('cooldown_s'), hold_s=v.get('hold_s'), hold_policy=v.get('hold_policy'), props=v.get('props'),
                active=ok, reason=reason)

    if bindings:
        for role in ('overview', 'relax', 'from_overview'):
            if bindings.get(role):
                add(bindings[role], type='binding', key=role, group='base')
        for c in bindings.get('idle_bases') or []:
            add(c, type='binding', key='idle_base', group='base')
    for f, c in fam_bases.items():
        add(c, type='base', key=f, group='base', hub=(f == hub) or None)
    for k, c in bridges.items():
        add(c, type='bridge', key=k, group='base')
    for f, c in references.items():
        add(c, type='family_reference', key=f, group='base', active=False, reason='只作姿势族的量尺')

    # Played by host executors outside the motion policy: walking, pose scenes, prop composites.
    for role, c in (doc('interaction/locomotion.json', {}).get('clips') or {}).items():
        add(c, type='locomotion', key=role, via='locomotion.json', group=None)
    for prof in doc('interaction/directional-locomotion.json', {}).get('profiles') or []:
        for role, c in [('loop', prof.get('clip')), ('start', (prof.get('start') or {}).get('clip')), ('stop', (prof.get('stop') or {}).get('clip'))]:
            if c:
                add(c, type='locomotion', key=prof.get('id'), role=role, via='directional-locomotion.json', group=None)
    for sc in doc('interaction/pose-scenes.json', {}).get('scenes') or []:
        for role, c in [('loop', sc.get('loop')), ('return', sc.get('return_clip'))] + [('variant', v.get('clip')) for v in sc.get('variants') or []]:
            if c:
                add(c, type='pose_scene', key=sc.get('id'), role=role, group=None)
    for b in doc('interaction/composites.json', {}).get('bindings') or []:
        add(b['ownerClip'], type='composite', key=b.get('entity'), animation=b.get('animation'), group=None)

    for row in actions:
        for c in row.get('clips') or []:
            add(c, type='action', key=row['id'], name=row.get('name'), section=row.get('section'), group=None, active=False, reason='手动动作面板')
        for c in row.get('required_clips') or []:
            add(c, type='action', key=row['id'], name=row.get('name'), section=row.get('section'), role='required', group=None, active=False,
                reason='手动动作面板')

    for c in list(uses):
        if c not in clips:
            note(f'{c}: used by the pack but missing from the archive')

    # A held loop's idle variants play only when something reaches that loop.
    reachable = set()
    for c, us in uses.items():
        if any(u.get('active') and u['type'] in POOL_TYPES - {'idle_variant', 'chain'} for u in us):
            todo = [c]
            while todo:
                x = todo.pop()
                for y in chain(x):
                    if y not in reachable:
                        reachable.add(y)
                        ex = (entries.get(y) or {}).get('exit')
                        if ex:
                            todo.append(ex)
    for c, us in uses.items():
        for u in us:
            if u['type'] == 'idle_variant' and u['key'] not in reachable:
                u.update(active=False, reason=f'没有池子会走到持续循环 {u["key"]}')

    # ---- groups ----
    order = [g for g, _, _ in GROUPS]
    direct_group = {}
    for c, us in uses.items():
        gs = [u['group'] for u in us if u.get('active') and u.get('group')] or \
             [u['group'] for u in us if u.get('group') and u['type'] not in ('family_reference', 'action')]
        if gs:
            direct_group[c] = min(gs, key=order.index)

    def chain_with_exits(start):
        """The policy chain from `start`, then the chain from each held clip's exit."""
        out, todo, seen = [], [start], set()
        while todo:
            c = todo.pop(0)
            for x in chain(c):
                if x in seen:
                    continue
                seen.add(x)
                out.append(x)
                ex = (entries.get(x) or {}).get('exit')
                if ex and held(x) and ex not in seen:
                    todo.append(ex)
        return out

    # chain members inherit their start's group
    member_of = defaultdict(list)
    for s in direct_group:
        for x in chain_with_exits(s)[1:]:
            if s not in member_of[x]:
                member_of[x].append(s)
    for x, ss in member_of.items():
        for s in ss:
            live = any(u.get('active') for u in uses[s] if u['type'] != 'chain')
            add(x, type='chain', key=s, group=direct_group[s], active=live, reason=None if live else f'{s} 不会被抽到')
    group = {}
    blocked = set()
    for c in all_clips:
        gs = [u['group'] for u in uses.get(c, []) if u.get('active') and u.get('group')]
        if not gs:
            # Named by a pool or seat the runtime skips: shown there, marked blocked.
            gs = [u['group'] for u in uses.get(c, []) if u.get('group') and u['type'] not in ('family_reference', 'action')]
            if gs:
                blocked.add(c)
        group[c] = min(gs, key=order.index) if gs else 'unwired'

    # ---- edges ----
    edges = {}

    def edge(frm, to, kind, blend, rule, why):
        if frm is None or to is None or frm == to:
            return
        e = edges.get((frm, to))
        if e is None:
            e = edges[(frm, to)] = dict(kinds=[], blend_s=r3(blend), blend_rule=rule, why=[], gap=measured_gap(frm, to),
                                        runtime_gap_cm=r1(runtime_gap(frm, to)))
        if kind not in e['kinds']:
            e['kinds'].append(kind)
        if why and why not in e['why']:
            e['why'].append(why)
        if e['blend_s'] is None and blend is not None:
            e['blend_s'], e['blend_rule'] = r3(blend), rule

    def default_rule(c):
        return 'blend-times 覆盖' if c in blend_in else f'默认 {crossfade}'

    def to_base(frm, target, duration, sourced, why, kind):
        """transition(target) where target is a base: the bridge between the families, else a blend over their gap."""
        a, b = fam_of(frm), start_fam(target)
        via = bridges.get(f'{a}>{b}') if a and b and a != b else None
        if via:
            edge(frm, via, kind, eff_blend(via, duration), f'换到桥接片段 {via}，用它的混合时间', why)
            bridge_out(via)
            return
        blend = duration if sourced else eff_blend(target, duration)
        rule = '源数据给的时间' if sourced else default_rule(target)
        g = runtime_gap(frm, target)
        if g is not None and g > seamless:
            syn = blend_seconds(g)
            if syn > blend:
                blend, rule = syn, f'按 {r1(g)} cm 族间距拉长'
        edge(frm, target, kind, blend, rule, why)

    def seat_rule(clip):
        return 'blend-times 覆盖' if clip in blend_in else f'座位默认 {seat_blend:g} s'

    bridged = set()

    def bridge_out(via):
        if via in bridged:
            return
        bridged.add(via)
        r = rules.get(via) or {}
        for k, c in bridges.items():
            if c == via:
                target = fam_bases[k.partition('>')[2]]
                if r.get('auto_return_blend') is not None:
                    d = r['auto_return_blend'] * (1 if r.get('auto_return_fixed_seconds') else (length(via) or 0))
                    to_base(via, target, d, True, f'桥接 {k} 走完', 'bridge')
                else:
                    to_base(via, target, crossfade, False, f'桥接 {k} 走完', 'bridge')

    def stage_base(clip):
        s = (file_rows.get(clip) or {}).get('start')
        b = fam_bases.get(s) if s else None
        return b if b and b != clip else None

    def entry(clip, why):
        """A drawn chain start: she first moves to its start family's base, then blends into it."""
        b = stage_base(clip)
        for frm in ([b] if b else idle_bases):
            if b:
                for ib in idle_bases:
                    if ib != b:
                        to_base(ib, b, crossfade, False, f'先回 {start_fam(clip)} 站姿再做 {clip}', 'base')
            blend, rule = eff_blend(clip, crossfade), default_rule(clip)
            g = runtime_gap(frm, clip)
            if g is not None and g > seamless:
                syn = blend_seconds(g)
                if syn > blend:
                    blend, rule = syn, f'按 {r1(g)} cm 族间距拉长'
            edge(frm, clip, 'start', blend, rule, why)

    walked = set()

    def walk(start, why):
        """Edges along a chain: next/auto-return, exits, idle variants, and from where it rests back to the bases."""
        todo = [start]
        while todo:
            c = todo.pop(0)
            if c in walked:
                continue
            walked.add(c)
            e = entries.get(c) or {}
            r = rules.get(c) or {}
            if r.get('auto_return_clip'):
                n = r['auto_return_clip']
                d = (r.get('auto_return_blend') or 0) * (1 if r.get('auto_return_fixed_seconds') else (length(c) or 0))
                if n in base_clip_family:
                    to_base(c, n, d, True, why, 'auto_return')
                else:
                    edge(c, n, 'auto_return', d, '源数据给的时间', why)
                todo.append(n)
            elif e.get('next'):
                n = e['next']
                kind = 'exit' if held(c) and e.get('exit') == n else 'next'
                if n in base_clip_family:
                    to_base(c, n, crossfade, False, why, kind)
                else:
                    edge(c, n, kind, eff_blend(n, crossfade), default_rule(n), '请求结束时' if kind == 'exit' else why)
                todo.append(n)
            if e.get('exit') and e['exit'] != e.get('next'):
                n = e['exit']
                edge(c, n, 'exit', eff_blend(n, crossfade), default_rule(n), '请求结束时' if held(c) else '被打断时')
                todo.append(n)
            for v in e.get('idle_variants') or []:
                edge(c, v, 'variant', eff_blend(v, crossfade), default_rule(v),
                     '持续 {:g}–{:g} s 后换变体'.format(*e['idle_interval_s']) if e.get('idle_interval_s') else '换变体')
                todo.append(v)
            rests = not next_clip(c) and not (e.get('exit') and held(c)) and not e.get('idle_variants')
            if rests and c not in base_clip_family and (posture(c) == 'stand' or posture(c) in lifted):
                d = crossfade
                if r.get('auto_return_exit_normalized') is not None and r.get('auto_return_blend') is not None:
                    d = r['auto_return_blend'] * (1 if r.get('auto_return_fixed_seconds') else (length(c) or 0))
                for b in idle_bases:
                    to_base(c, b, d, False, '动作结束回站姿：空闲回原站姿或中心站姿，忙或会话中回 relax' if b == relax_clip
                            else '动作结束回站姿：空闲（或说话）时回中心站姿', 'end')
            elif rests and c not in base_clip_family and posture(c) != 'stand' and posture(c) not in lifted and not e.get('exit'):
                note(f'{c}: a chain rests in {posture(c)} with no exit back to standing')

    # base moves between the idle bases
    for a_ in idle_bases:
        for b_ in idle_bases:
            if a_ != b_:
                to_base(a_, b_, crossfade, False, '在两个空闲站姿之间切换', 'base')

    seat_handled = set()
    for c, us in uses.items():
        for u in us:
            if not u.get('active'):
                continue
            t = u['type']
            if t in ('event', 'tier') and (u.get('posture') or u.get('stance') or 'stand') != 'stand':
                for l in u.get('loops', []):
                    if not l['drawn']:
                        continue
                    if l.get('seat') is not None:
                        g_in = (file_rows.get(c) or {}).get('start_cm')
                        g_out = (file_rows.get(c) or {}).get('end_cm')
                        bi = blend_seconds(g_in) if g_in is not None and g_in > seamless else eff_blend(c, seat_blend)
                        bo = max(off_loop_blend, blend_seconds(g_out)) if g_out is not None and g_out > seamless else eff_blend(l['loop'], seat_blend)
                        ri = f'座位：按 {g_in} cm 拉长' if g_in is not None and g_in > seamless else seat_rule(c)
                        ro = f'座位：回循环至少 {off_loop_blend} s，按 {g_out} cm' if g_out is not None and g_out > seamless else seat_rule(l['loop'])
                    else:
                        bi, ri = eff_blend(c, crossfade), f'默认 {crossfade}'
                        bo, ro = eff_blend(l['loop'], crossfade), f'默认 {crossfade}'
                    edge(l['loop'], c, 'detour', bi, ri, f'{u["key"]}：坐着时插入')
                    edge(c, l['loop'], 'detour', bo, ro, f'{u["key"]}：回到座位循环')
                continue
            if t in ('event', 'tier', 'activity', 'speech', 'intent', 'point', 'click_reaction', 'fidget'):
                why = f'{t}:{u["key"]}'
                entry(c, why)
                walk(c, why)
            elif t == 'seat' and u['key'] not in seat_handled:
                seat_handled.add(u['key'])
                use = next(x for x in affordance['uses'] if x['id'] == u['key'])
                loop = use['loop']
                if use.get('enter'):
                    entry(use['enter'], f'座位 {use["id"]}：坐下')
                    edge(use['enter'], loop, 'seat', eff_blend(loop, seat_blend), seat_rule(loop), f'座位 {use["id"]}：坐稳')
                else:
                    for b in idle_bases:
                        edge(b, loop, 'seat', eff_blend(loop, seat_blend), f'先淡出 {window_fade:g} s，看不见时切换', f'座位 {use["id"]}：坐到窗口顶')
                if use.get('exit'):
                    edge(loop, use['exit'], 'seat', eff_blend(use['exit'], seat_blend), seat_rule(use['exit']), f'座位 {use["id"]}：起身')
                    walk(use['exit'], f'座位 {use["id"]}：起身后')
                elif not use.get('enter'):
                    for b in idle_bases:
                        edge(loop, b, 'seat', eff_blend(b, seat_blend), '先淡出，看不见时切换', f'座位 {use["id"]}：离开窗口顶')
                for v in use.get('variants') or []:
                    if use.get('surface') != 'seat':
                        continue
                    vc = v['clip']
                    g_in = (file_rows.get(vc) or {}).get('start_cm')
                    g_out = (file_rows.get(vc) or {}).get('end_cm')
                    bi = blend_seconds(g_in) if g_in is not None and g_in > seamless else eff_blend(vc, seat_blend)
                    bo = max(off_loop_blend, blend_seconds(g_out)) if g_out is not None and g_out > seamless else eff_blend(loop, seat_blend)
                    edge(loop, vc, 'seat_variant', bi, f'座位：按 {g_in} cm 拉长' if g_in is not None and g_in > seamless else seat_rule(vc),
                         f'座位 {use["id"]} 变体 {v["id"]}')
                    edge(vc, loop, 'seat_variant', bo, f'座位：回循环至少 {off_loop_blend} s，按 {g_out} cm' if g_out is not None and g_out > seamless
                         else seat_rule(loop), f'座位 {use["id"]} 变体 {v["id"]} 结束')

    # ---- chains for the timelines ----
    def hold_info(c):
        """(range seconds or None, note) of a loop segment."""
        e = entries.get(c) or {}
        if held(c):
            if e.get('idle_variants'):
                return e.get('idle_interval_s'), f'持续，每 {e["idle_interval_s"][0]:g}–{e["idle_interval_s"][1]:g} s 插一个变体'
            for u in affordance['uses']:
                if u['loop'] == c:
                    return None, '坐着直到起身'
                for v in u.get('variants') or []:
                    if v['clip'] == c and v.get('hold_s'):
                        return v['hold_s'], f'座位变体，持续 {v["hold_s"][0]:g}–{v["hold_s"][1]:g} s'
            return None, '持续到请求结束（会话状态或活动结束）'
        if loops(c):
            if e.get('hold_seconds') is not None:
                return [float(e['hold_seconds'])] * 2, f'循环 {float(e["hold_seconds"]):g} s'
            for u in affordance['uses']:
                for v in u.get('variants') or []:
                    if v['clip'] == c and v.get('hold_s'):
                        return v['hold_s'], f'座位变体，持续 {v["hold_s"][0]:g}–{v["hold_s"][1]:g} s'
            if any(u['type'] in ('event', 'tier') and (u.get('posture') or u.get('stance', 'stand')) != 'stand' for u in uses.get(c, [])):
                return detour_hold, f'坐着插入，按整圈持续 {detour_hold[0]:g}–{detour_hold[1]:g} s'
            if c in base_clip_family or c in idle_bases:
                return None, '站姿循环，一直播'
            return None, '没有时长，不会自己结束'
        return None, None

    def chain_doc(start):
        segs, prev = [], None
        for c in chain_with_exits(start):
            hr, hold_note = hold_info(c)
            seg = dict(clip=c, length_s=r3(length(c)), loop=loops(c), held=held(c) or None, hold_range_s=[r3(x) for x in hr] if hr else None,
                       note=hold_note)
            if prev is not None:
                e = edges.get((prev, c))
                pr = rules.get(prev) or {}
                if e:
                    seg['blend_in_s'] = e['blend_s']
                elif pr.get('auto_return_clip') == c and pr.get('auto_return_blend') is not None:
                    seg['blend_in_s'] = r3(pr['auto_return_blend'] * (1 if pr.get('auto_return_fixed_seconds') else (length(prev) or 0)))
                else:
                    seg['blend_in_s'] = r3(eff_blend(c, crossfade))
            segs.append(seg)
            prev = c
        return segs

    chains = {}
    clip_chains = defaultdict(list)
    reached = set()
    for c in all_clips:
        e = entries.get(c) or {}
        reached.update(x for x in [next_clip(c), e.get('exit')] + list(e.get('idle_variants') or []) if x and x != c)
    roots = [c for c in direct_group if c in clips] + [c for c in all_clips if c not in reached and c not in direct_group]
    for s in roots:
        segs = chain_doc(s)
        if len(segs) == 1 and s in reached:
            continue
        chains[s] = segs
        for seg in segs:
            if s not in clip_chains[seg['clip']]:
                clip_chains[seg['clip']].append(s)

    # ---- clips ----
    supp_derived = {r['name']: r.get('derived_motion') for r in doc('animation/supplemental-clips.json', {'clips': []})['clips']
                    if r.get('derived_motion')}
    media_clips = {t['clip'] for t in doc('animation/motion-media.json', {'tracks': []})['tracks']}

    def origin(c):
        """game, imported or generated."""
        m = meta.get(c) or {}
        if m.get('source_clip_name'):
            return origin(m['source_clip_name'])
        kind = (m.get('curve_provenance') or {}).get('kind')
        if kind in GENERATED_KINDS:
            return 'generated'
        return 'imported' if kind in IMPORTED_KINDS or c in media_clips else 'game'

    out_clips = []
    for c in all_clips:
        m = meta.get(c) or {}
        fps = m.get('frame_rate')
        L = length(c)
        e = entries.get(c) or {}
        r = rules.get(c) or {}
        src = None
        if m.get('source_clip_name'):
            s0, s1 = m['source_time_range']
            src = dict(clip=m['source_clip_name'], start_s=r3(s0), end_s=r3(s1), source_length_s=r3(m.get('source_length')))
        d = supp_derived.get(c)
        derived = dict(kind=d.get('kind'), source_character=d.get('source_character'), source_clip=d.get('source_clip')) if d else None
        ar = None
        if r.get('auto_return_exit_normalized') is not None or r.get('auto_return_clip'):
            nrm = r.get('auto_return_exit_normalized')
            ar = dict(clip=r.get('auto_return_clip'), exit_normalized=r3(nrm), exit_at_s=r3(nrm * L) if nrm is not None else None,
                      blend_s=r3((r.get('auto_return_blend') or 0) * (1 if r.get('auto_return_fixed_seconds') else L))
                      if r.get('auto_return_blend') is not None else None)
        nxt = next_clip(c)
        fr = fam_rows.get(c)
        hr, hold_note = hold_info(c)
        st = metadata.get(c) or {}
        row = dict(
            name=c, group=group[c],
            length_s=r3(L), frames=int(round(L * fps)) if fps else None, fps=fps, loop=loops(c), held=held(c) or None,
            hold_s=r3(e.get('hold_seconds')), hold_range_s=[r3(x) for x in hr] if hr else None, hold_note=hold_note,
            interruptible=e.get('interruptible'), exit_condition=e.get('exit_condition'), end_at_length=e.get('end_at_length'),
            stroke_s=e.get('stroke_s'), intents=e.get('intents'), in_motion_map=c in entries or None,
            source=src, derived=derived, origin=origin(c),
            next=e.get('next'), exit=e.get('exit'), auto_return=ar, idle_variants=e.get('idle_variants'),
            blend_in_s=r3(blend_in[c]['blend_in_s']) if c in blend_in else None, blend_in_source=(blend_in.get(c) or {}).get('source'),
            blend_to_next_s=(edges.get((c, nxt)) or {}).get('blend_s') if nxt else None,
            family=dict(start=fr['start'], start_cm=fr['start_cm'], end=fr['end'], end_cm=fr['end_cm'], measured_here=fr['measured']) if fr else None,
            stance=dict(start=st.get('stance_start'), end=st.get('stance_end')) if st else None,
            excluded_family=excluded.get(c), blocked=c in blocked or None,
            uses=uses.get(c, []), chains=clip_chains.get(c, []),
        )
        out_clips.append({k: v for k, v in row.items() if v is not None})

    out_edges = [dict(id=f'edge:{frm}>{to}', **{'from': frm}, to=to, kind=e['kinds'][0], **e) for (frm, to), e in edges.items()]

    known_entry = {'next', 'exit', 'hold_seconds', 'interruptible', 'end_at_length', 'exit_condition', 'prepare_clips', 'hold_policy',
                   'intents', 'stroke_s', 'idle_variants', 'idle_interval_s', 'complete_on_enter'}
    for c, e in entries.items():
        for k in e:
            if k not in known_entry:
                note(f'intent-motion-map clip field {k} ({c})')
    known_top = {'schema', 'status', 'crossfade_seconds', 'clips', 'idle_fidget', 'activities', 'speech_gestures', 'click_reactions',
                 'point_clip', 'events', 'idle_tiers', 'motion_library', 'seat_redraw_cm', 'seat_variant_hold_s'}
    for k in im:
        if k not in known_top:
            note(f'intent-motion-map top-level {k}')
    for u in affordance['uses']:
        for k in u:
            if k not in {'id', 'surface', 'height_range', 'align', 'enter', 'loop', 'exit', 'props', 'variants', 'lock_pelvis_height',
                         'enter_style', 'headroom', 'min_segment'}:
                note(f'affordance-uses field {k} ({u["id"]})')

    result = dict(
        schema=SCHEMA, character=character, crossfade_s=crossfade, runtime=K,
        bases=fam_bases, hub=hub, hub_clip=hub_clip, relax_clip=relax_clip, bridges=bridges, references=references,
        family_gaps_cm=family_gaps, bindings=bindings,
        groups=[dict(id=g, title=t, parent=p) for g, t, p in GROUPS],
        clips=out_clips, edges=out_edges, chains=chains,
        # Aligned key-bone points in cm to 2 decimals: at 1, rounding alone moves a re-measured gap by up to 0.17 cm.
        poses={n: dict(start=[[round(float(x) * 100, 2) for x in p] for p in a[1]], end=[[round(float(x) * 100, 2) for x in p] for p in b[1]])
               for n, (a, b) in pose_ends.items()},
        unmapped=unmapped,
        counts=dict(clips=len(out_clips), edges=len(out_edges), chains=len(chains),
                    edges_over_8cm=sum(1 for e in out_edges if e['gap'] is not None and e['gap'] > 8),
                    edges_unmeasured=sum(1 for e in out_edges if e['gap'] is None),
                    clips_in_no_pool=sum(1 for c in out_clips if not any(u.get('active') and u['type'] in POOL_TYPES for u in c['uses']))),
    )
    size = len(text(result).encode())
    if size > MAX_BYTES:
        raise ValueError(f'motion_graph_too_large:{size}')
    return result


def text(document):
    """The document as a pack data file is written."""
    return json.dumps(document, ensure_ascii=False, indent=2) + '\n'


def archive_frames(archive_path, names, humanoid):
    """({clip: (rotations, positions, scales) of its first and last frame}, {clip: clip document}, [clips not readable]);
    humanoid: the rig's humanoid.json document, as MotionArchive takes it."""
    # interaction_motion needs scipy; graph() does not.
    from .interaction_motion import MotionArchive
    ends, meta, failed = {}, {}, []
    try:
        archive = MotionArchive(archive_path, humanoid)
    except (OSError, ValueError, KeyError):
        return ends, meta, list(names)
    for name in names:
        try:
            m, _, pose = archive.sample(name, [0, -1])
        except (OSError, ValueError, KeyError, IndexError):
            failed.append(name)
            continue
        ends[name] = tuple(pose[k] for k in ['rotations', 'positions', 'scales'])
        meta[name] = m
    return ends, meta, failed


def pack_graph(character, pack, archive_path, animation=None, interaction=None, added=None, previous=None):
    """The graph of the C7 pack at `pack` (its pack.json) and its actor archive; `animation` and `interaction`
    ({file: document}) replace the pack's files, `added` ({clip: row with length and loop}) are clips the archive
    does not hold yet. With `previous`, the pack's graph before an edit that left every clip's frames as they were,
    clip poses come from it and the archive is not sampled; a clip it lacks is unmeasured."""
    pack, archive_path = Path(pack), Path(archive_path)
    planned = dict(animation=animation or {}, interaction=interaction or {})
    documents = {}
    for section, name in DOCUMENTS:
        path = pack.parent/section/name
        documents[f'{section}/{name}'] = planned[section].get(name) or (read(path) if path.is_file() else None)
    documents['palette'] = read(pack.parent/'animation'/read(pack)['animation']['palette_contract']['file'])
    archive = read(archive_path)
    clips = {r['name']: r for r in archive['clips']}
    humanoid = pack_humanoid(pack)
    if previous is None:
        ends, meta, failed = archive_frames(archive_path, list(clips), humanoid)
    else:
        ends, failed = {}, [n for n in clips if n not in previous['poses']]
        meta = {n: read(archive_path.parent/r['file']) for n, r in clips.items() if n not in failed}
    clips.update({n: r for n, r in (added or {}).items() if n not in clips})
    return graph(character, documents, clips, read(archive_path.parent/archive['rig']['file']), ends, meta,
                 failed + [n for n in (added or {}) if n not in ends], previous, humanoid)


def graft(package_path, output):
    """The character package at `package_path` copied to the NEW directory `output` with animation/motion-graph.json
    (re)written and registered in its pack, every reference rehashed and the version's patch bumped; returns the counts."""
    package = Package(package_path); output = Path(output).resolve()
    need(not output.exists() and not output.is_relative_to(package.root), 'invalid_motion_graph_output')
    output.parent.mkdir(parents=True, exist_ok=True); stage = Path(tempfile.mkdtemp(prefix='.motion-graph-', dir=output.parent)); shutil.rmtree(stage)
    try:
        shutil.copytree(package.root, stage, symlinks=True, copy_function=clone_or_copy)
        native_path = stage/package.native_ref['file']; root = native_path.parent; native = read_json(native_path); entry = native['characters'][0]
        pack_path = root/entry['c7']['file']; animation = pack_path.parent/'animation'
        document = pack_graph(package.id, pack_path, root/entry['actor_archive']['file'])
        path = animation/FILE; path.write_text(text(document))
        pack = read_json(pack_path)
        pack['animation']['data'] = [r for r in pack['animation']['data'] if r['file'] != FILE] + [reference(path, animation)]
        write_json(pack_path, pack); entry['c7'] = reference(pack_path, root)
        roles = {r['file']: r['roles'] for r in native['files']}
        native['files'] = [dict(**reference(p, root), roles=roles.get(p.relative_to(root).as_posix(), ['motion_graph']))
                           for p in sorted(root.rglob('*')) if p.is_file() and p != native_path]
        write_json(native_path, native); native_bundle.verify(root)
        definition = read_json(stage/'character.json'); definition['components']['render']['native_bundle'] = reference(native_path, stage)
        major, minor, patch = map(int, definition['version'].split('.')); definition['version'] = f'{major}.{minor}.{patch + 1}'
        definition['inventory'] = [reference(p, stage) for p in sorted(stage.rglob('*')) if p.is_file() and p != stage/'character.json']
        write_json(stage/'character.json', definition); Package(stage); stage.rename(output)
        return document['counts']
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def graft_library(catalog, output):
    """A NEW library at output/library: every character of the library `catalog` (its current.json), each package with a
    renderer through graft (built under output/packages-built), the same default character. Returns {id: counts}."""
    catalog, output = Path(catalog).resolve(), Path(output).resolve()
    need(not output.exists() and not output.is_relative_to(catalog.parent), 'invalid_motion_graph_output')
    source = Library(catalog.parent, catalog.name)
    packages = source.packages()
    output.mkdir(parents=True)
    try:
        counts, built = {}, []
        library = Library(output/'library'); library.root.mkdir()
        for original in packages:
            path = original.root
            if original.render_enabled:
                path = output/'packages-built'/original.id
                counts[original.id] = graft(original.root, path)
            package = Package(path); dest = library.root/'packages'/package.id/package.sha256; dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(package.root, dest, symlinks=True, copy_function=clone_or_copy); built.append(Package(dest, deep=False))
        library.publish(built, default=source.snapshot()['default_character'])
        write_json(output/'result.json', dict(passed=True, characters=counts))
        return counts
    except BaseException:
        shutil.rmtree(output)
        raise


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--catalog', type=Path, required=True)
    p.add_argument('--character', help='write that character\'s graph to the file --output; without it, --output is the new library\'s directory')
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    catalog = a.catalog.resolve()
    if a.character is None:
        print(json.dumps(graft_library(catalog, a.output), ensure_ascii=False))
    else:
        native = catalog.parent/read(catalog)['native_bundle']['file']
        entry = next(e for e in read(native)['characters'] if e['id'] == a.character)
        document = pack_graph(a.character, native.parent/entry['c7']['file'], native.parent/entry['actor_archive']['file'])
        a.output.parent.mkdir(parents=True, exist_ok=True)
        a.output.write_text(text(document))
        print(json.dumps(document['counts'], ensure_ascii=False))
