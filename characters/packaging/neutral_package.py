#!/usr/bin/env python3
"""Split a Metal frame graph into the neutral scene, the Metal product data and the build record, and emit it back.

  scene   (neutral/scene.json, endfield-neutral-scene/v1): the original passes, their targets, textures and samplers, the
          visible draws, per-frame overrides and the state overrides as built today. uber-post writes post-gamma at render size.
  metal   (metal/product.json): the product pipeline (smaa-* and other product passes, their targets, textures and samplers,
          spatial_antialiasing, aa_product_profile, output, output_semantic) and which fused adapter rewrites uber-post.
  record  (neutral/build-record.json): build record, product_look, and the key order and positions the byte-identical emit needs.
emit_metal applies the Mac boundary rules: fullscreen vertex adapters, source_coordinate_policy and the fused uber-post rewrite.
Fullscreen stage 0 resources are absent from today's graph (frame_build.py skips them); the scene does not invent them.
The scene still refers to source/manifest.json by draw index, bound by manifest_sha256.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys

FRAME_SCHEMA = 'metal-frame-graph-v1'
SCENE_SCHEMA = 'endfield-neutral-scene/v1'
PRODUCT_SCHEMA = 'endfield-metal-product/v1'
RECORD_SCHEMA = 'endfield-neutral-build-record/v1'
COORDINATES = 'unity-reversed-z-msl-boundary'
HELPER_VS = 'unity-fullscreen-metal'
PRODUCT_VS = 'source-output-y-complement'
FUSED = 'unity-ssaa2-fused-grade-v1'
FUSED_ADD = 'unity-ssaa2-fused-grade-add-v1'
POST_GAMMA = 'post-gamma'
PRODUCT_KINDS = {'premultiply_alpha', 'coverage_rgb', 'max_edges', 'unpremultiply_alpha', 'linearize_post', 'downsample_l1'}

SCENE_TOP = ('manifest_sha256', 'width', 'height', 'targets', 'textures', 'semantic_textures', 'sampler_overrides', 'passes', 'frame_inputs')
METAL_TOP = ('output', 'output_semantic', 'spatial_antialiasing', 'aa_product_profile')
RECORD_TOP = ('full_frame_ready', 'product_look')
RULE_TOP = ('schema', 'source_coordinate_policy', 'presentation_additive')
PASS_KEYS = {'id', 'phase', 'kind', 'colors', 'depth', 'stencil', 'reads', 'draws', 'geometry', 'front_facing', 'viewport', 'texture_bindings',
             'sampler_overrides', 'fullscreen'}
FULLSCREEN_KEYS = ('stages', 'resources', 'native_state')
ADAPTER_KEYS = ('vertex_adapter', 'fragment_adapter')
SCENE_FRAME = ('visible_draws', 'overrides', 'state_overrides')
RECORD_FRAME = ('capture_sha256', 'frame_index', 'time_seconds', 'current_previous_validated', 'producer_mode')


def need(ok, message):
    if not ok:raise ValueError(message)


def known(d, keys, where):
    extra = [k for k in d if k not in keys]
    need(not extra, 'unknown %s key(s) %s' % (where, ', '.join(extra)))


def dumps(graph):return json.dumps(graph, indent=2)+'\n'
def attachment(target, load):return dict(target=target, load=load, store='store', clear=[0, 0, 0, 0])
def product_pass(p):return p['phase'].startswith('smaa-') or p['kind'] in PRODUCT_KINDS


def vertex_adapter(p, product):
    """The Mac fullscreen VS: product kernels keep their source VS with the Y complement; original fullscreen draws run the Unity
    helper VS, except in passes that test depth/stencil (frame_build native_resolve), which run their compiled source VS."""
    if product:return PRODUCT_VS
    return None if 'depth' in p or 'stencil' in p else HELPER_VS


def post_output(product):
    return (product.get('spatial_antialiasing') or {}).get('input') or product['output']


def place(base, items, positions, where):
    """Inserts items at their recorded final indices into base."""
    need(len(items) == len(positions), '%s: %d items, %d positions' % (where, len(items), len(positions)))
    out = list(base)
    for i, item in sorted(zip(positions, items), key=lambda x:x[0]):
        need(i <= len(out), '%s position %d beyond %d' % (where, i, len(out))); out.insert(i, item)
    return out


def split(graph):
    g = copy.deepcopy(graph)
    known(g, SCENE_TOP+METAL_TOP+RECORD_TOP+RULE_TOP, 'top-level')
    known(g['frame_inputs'], SCENE_FRAME+RECORD_FRAME, 'frame_inputs')
    need(g['schema'] == FRAME_SCHEMA, 'schema %s is not %s' % (g['schema'], FRAME_SCHEMA))
    need(g.get('source_coordinate_policy') == COORDINATES, 'source_coordinate_policy %s is not %s' % (g.get('source_coordinate_policy'), COORDINATES))
    for p in g['passes']:
        known(p, PASS_KEYS, 'pass %s' % p['id'])
        for f in p.get('fullscreen') or []:known(f, FULLSCREEN_KEYS+ADAPTER_KEYS, 'fullscreen in pass %s' % p['id'])
    product = {k: g[k] for k in METAL_TOP if k in g}
    fused = None; scene_passes = []; product_passes = []; pass_positions = []
    for i, p in enumerate(g['passes']):
        is_product = product_pass(p)
        for f in p.get('fullscreen') or []:
            order = list(f)
            need(order == [k for k in order if k not in ADAPTER_KEYS]+[k for k in ADAPTER_KEYS if k in f], 'pass %s: adapters are not the last fullscreen keys' % p['id'])
            expected = vertex_adapter(p, is_product)
            need(f.pop('vertex_adapter', None) == expected, 'pass %s: vertex_adapter differs from the rule (%s)' % (p['id'], expected))
        if is_product:
            need(not any('fragment_adapter' in f for f in p.get('fullscreen') or []), 'product pass %s has a fragment adapter' % p['id'])
            product_passes.append(p); pass_positions.append(i); continue
        if any('fragment_adapter' in f for f in p.get('fullscreen') or []):
            need(fused is None and p['phase'] == 'uber-post' and len(p['fullscreen']) == 1, 'fragment adapter outside the one uber-post: %s' % p['id'])
            fused = unfuse(g, p, post_output(product))
        scene_passes.append(p)
    need(fused is not None or 'presentation_additive' not in g, 'presentation_additive without a fused uber-post')
    written = {c['target'] for p in product_passes for c in p['colors']}
    product_targets = written | {product['output']} | {v for k, v in (product.get('spatial_antialiasing') or {}).items() if k != 'kind'}
    if fused:product_targets |= {post_output(product)} | ({fused['presentation_additive']} if 'presentation_additive' in fused else set())
    for p in scene_passes:
        used = [c['target'] for c in p['colors']]+p['reads']+list((p.get('texture_bindings') or {}).values())
        need(not set(used) & product_targets, 'original pass %s uses product target(s) %s' % (p['id'], sorted(set(used) & product_targets)))
    scene_reads = {r for p in scene_passes for r in p['reads']}
    product_textures = {r for p in product_passes for r in p['reads']}-scene_reads
    programs = {'%s:%s' % (s['stage'], s['source_spirv_sha256']) for p in product_passes for f in p.get('fullscreen') or [] for s in f['stages']}
    targets = [t for t in g['targets'] if t['id'] not in product_targets]
    if fused:
        need(all(t['id'] != POST_GAMMA for t in g['targets']), '%s already exists beside a fused uber-post' % POST_GAMMA)
        at = next(i for i, t in enumerate(g['targets']) if t['id'] == post_output(product))
        before = sum(1 for t in g['targets'][:at] if t['id'] not in product_targets)
        targets.insert(before, dict(id=POST_GAMMA, width=g['width'], height=g['height'], format='rgba32Float'))
    samplers = g['sampler_overrides']
    product_sampler = lambda k:k.split(':')[0]+':'+k.split(':')[1] in programs
    fi = g['frame_inputs']
    scene = dict(schema=SCENE_SCHEMA)
    for k in SCENE_TOP:
        if k in g:scene[k] = g[k]
    scene.update(targets=targets, textures=[t for t in g['textures'] if t['id'] not in product_textures], passes=scene_passes,
                 sampler_overrides={k: v for k, v in samplers.items() if not product_sampler(k)}, frame_inputs={k: fi[k] for k in fi if k in SCENE_FRAME})
    metal = dict(schema=PRODUCT_SCHEMA, **product, targets=[t for t in g['targets'] if t['id'] in product_targets],
                 textures=[t for t in g['textures'] if t['id'] in product_textures], passes=product_passes,
                 sampler_overrides={k: v for k, v in samplers.items() if product_sampler(k)})
    if fused:metal['fused_post'] = fused
    record = dict(schema=RECORD_SCHEMA, **{k: g[k] for k in RECORD_TOP if k in g}, frame_inputs={k: fi[k] for k in fi if k in RECORD_FRAME},
                  key_order=dict(graph=list(g), frame_inputs=list(fi)),
                  positions=dict(targets=[i for i, t in enumerate(g['targets']) if t['id'] in product_targets],
                                 textures=[i for i, t in enumerate(g['textures']) if t['id'] in product_textures], passes=pass_positions,
                                 sampler_overrides=[i for i, k in enumerate(samplers) if product_sampler(k)]))
    return scene, metal, record


def unfuse(g, uber, post):
    """Returns uber-post to its original form: one color, post-gamma, no adapter."""
    f = uber['fullscreen'][0]; adapter = f.pop('fragment_adapter')
    need(adapter in (FUSED, FUSED_ADD), 'uber-post fragment adapter %s is not a fused grade' % adapter)
    fused = dict(fragment_adapter=adapter); colors = uber['colors']
    need(colors[0]['target'] == post, 'fused uber-post writes %s, not %s' % (colors[0]['target'], post))
    if adapter == FUSED_ADD:
        additive = g.get('presentation_additive'); blend = f['native_state']['blend']
        need(len(colors) == 2 and colors[1] == attachment(additive, 'dontCare'), 'additive uber-post colors differ from the adapter rule')
        need(list(blend)[-1] == 'rtBlend1' and blend['rtBlend1'] == blend['rtBlend0'], 'additive uber-post rtBlend1 differs from the adapter rule')
        del blend['rtBlend1']; fused['presentation_additive'] = additive
    else:need(len(colors) == 1 and 'presentation_additive' not in g, 'fused uber-post without the add adapter writes %d colors' % len(colors))
    uber['colors'] = [dict(colors[0], target=POST_GAMMA)]
    return fused


def emit_metal(scene, metal, record):
    need(scene['schema'] == SCENE_SCHEMA and metal['schema'] == PRODUCT_SCHEMA and record['schema'] == RECORD_SCHEMA, 'schema mismatch')
    s, m, r = copy.deepcopy(scene), copy.deepcopy(metal), copy.deepcopy(record); positions = r['positions']
    for p, is_product in [(p, False) for p in s['passes']]+[(p, True) for p in m['passes']]:
        adapter = vertex_adapter(p, is_product)
        for f in p.get('fullscreen') or []:
            if adapter:f['vertex_adapter'] = adapter
    targets = s['targets']; values = {}
    fused = m.get('fused_post')
    if fused:
        ubers = [p for p in s['passes'] if p['phase'] == 'uber-post']
        need(len(ubers) == 1 and len(ubers[0]['colors']) == 1 and len(ubers[0]['fullscreen']) == 1, 'fused rewrite needs one single-color uber-post')
        uber = ubers[0]; f = uber['fullscreen'][0]
        targets = [t for t in targets if t['id'] != uber['colors'][0]['target']]
        uber['colors'][0]['target'] = post_output(m); f['fragment_adapter'] = fused['fragment_adapter']
        additive = fused.get('presentation_additive')
        need((fused['fragment_adapter'] == FUSED_ADD) == (additive is not None), 'fused adapter %s and presentation_additive disagree' % fused['fragment_adapter'])
        if additive:
            uber['colors'].append(attachment(additive, 'dontCare')); blend = f['native_state']['blend']; blend['rtBlend1'] = dict(blend['rtBlend0'])
            values['presentation_additive'] = additive
    samplers = place(list(s['sampler_overrides'].items()), list(m['sampler_overrides'].items()), positions['sampler_overrides'], 'sampler_overrides')
    values.update({k: s[k] for k in SCENE_TOP if k in s}, schema=FRAME_SCHEMA, source_coordinate_policy=COORDINATES,
                  **{k: m[k] for k in METAL_TOP if k in m}, **{k: r[k] for k in RECORD_TOP if k in r},
                  targets=place(targets, m['targets'], positions['targets'], 'targets'),
                  textures=place(s['textures'], m['textures'], positions['textures'], 'textures'),
                  passes=place(s['passes'], m['passes'], positions['passes'], 'passes'), sampler_overrides=dict(samplers))
    frame = dict(s['frame_inputs'], **r['frame_inputs']); order = r['key_order']
    need(set(order['frame_inputs']) == set(frame), 'frame_inputs keys %s differ from the recorded order' % sorted(set(order['frame_inputs']) ^ set(frame)))
    values['frame_inputs'] = {k: frame[k] for k in order['frame_inputs']}
    need(set(order['graph']) == set(values), 'graph keys %s differ from the recorded order' % sorted(set(order['graph']) ^ set(values)))
    return {k: values[k] for k in order['graph']}


def checked(base, entry, label):
    path = (base/entry['file']).resolve(); need(path.is_relative_to(base) and path.is_file(), '%s missing: %s' % (label, entry['file']))
    data = path.read_bytes()
    need(len(data) == entry['byte_count'] and hashlib.sha256(data).hexdigest() == entry['sha256'], '%s %s does not match its sha256/length' % (label, entry['file']))
    return data


def library_graph(current, character):
    """The bytes of one character's graph/frame-graph.json in a release library (current.json)."""
    current = Path(current).resolve(); base = current.parent; index = json.loads(current.read_text())
    native = json.loads(checked(base, index['native_bundle'], 'native bundle'))
    entry = next((c for c in native['characters'] if c['id'] == character), None); need(entry is not None, 'no character %s' % character)
    return checked(base, entry['graph'], 'frame graph')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--library', required=True, help='release library current.json')
    ap.add_argument('--character', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--check', action='store_true', help='compare metal/frame.json with the library frame-graph.json byte for byte')
    a = ap.parse_args(argv)
    raw = library_graph(a.library, a.character); out = Path(a.out)
    files = dict(zip(('neutral/scene.json', 'metal/product.json', 'neutral/build-record.json'), split(json.loads(raw))))
    for name, value in files.items():
        (out/name).parent.mkdir(parents=True, exist_ok=True); (out/name).write_text(dumps(value))
    emitted = dumps(emit_metal(*(json.loads((out/name).read_text()) for name in files))).encode()
    (out/'metal/frame.json').write_bytes(emitted)
    if not a.check:return 0
    if emitted == raw:
        print('%s frame-graph.json byte-identical (%s)' % (a.character, hashlib.sha256(raw).hexdigest())); return 0
    offset = next((i for i, (x, y) in enumerate(zip(emitted, raw)) if x != y), min(len(emitted), len(raw)))
    print('%s frame-graph.json differs at byte %d (emitted %d bytes, library %d bytes)' % (a.character, offset, len(emitted), len(raw))); return 1


if __name__ == '__main__':
    sys.exit(main())
