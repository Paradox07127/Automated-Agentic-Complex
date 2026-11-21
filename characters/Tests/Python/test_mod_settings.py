"""The importer's mod settings table (endfield-mod-settings/v1) from synthetic EFMI mods: no byte of a user mod or of game data."""
import copy
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_import_outfit import BODY, CLOTH, MOVED_POSITIONS, cloth_mod, dds, package_fixture, tools_mod
from agentic_complex_build import efmi_mod, import_outfit, mod_settings, outfit_compose
from character_library import Package, check_mod_settings, read_json

RED, BLUE, GREEN = dds(8, 8, 99, fill=1), dds(8, 8, 99, fill=2), dds(8, 8, 99, fill=3)
# Mod index buffer: always-drawn A, coat 0's B, coat 1's C, then the panties' P.
IB = [0, 1, 2, 2, 1, 3, 1, 2, 3, 0, 2, 1]

SWITCH_INI = '''[Constants]
global persist $coat = 0
global persist $color = 0
{constants}
[KeyCoat]
; 外套
key = VK_F1
type = cycle
$coat = 0, 1

[KeyColor]
key = VK_F2
type = cycle
$color = 0, 1, 2
{keys}
[TextureOverride_EntryPoint_LOD0.40609654_6_0]
hash = 40609654
match_first_index = 0
match_index_count = 6
$\\EFMIv1\\component_id = 0
run = CommandList_Draw

[CommandList_Draw]
ib = Resource_IB
{vb0}
if $color == 0
    ps-t0 = ResourceRed
else if $color == 1
    ps-t0 = ResourceBlue
else
    ps-t0 = ResourceGreen
endif
drawindexed = 3, 0, 0
if $coat == 0
    drawindexed = 3, 3, 0
else
    drawindexed = 3, 6, 0
endif
{draws}

[Resource_IB]
type = Buffer
format = DXGI_FORMAT_R16_UINT
filename = Meshes/IB.buf

[Resource_Position]
type = Buffer
stride = 16
filename = Meshes/Position.buf

[ResourceRed]
filename = Textures/red.dds

[ResourceBlue]
filename = Textures/blue.dds

[ResourceGreen]
filename = Textures/green.dds
'''
PANTIES = dict(constants='global persist $panties = 1\n', keys='\n[KeyPanties]\nkey = VK_F3\ntype = cycle\n$panties = 0, 1\n',
               draws='if $panties == 0\n    drawindexed = 3, 9, 0\nendif')


def switch_mod(root, geometry=True, panties=False):
    """SWITCH_INI drawn from its own index buffer, with its own positions unless not `geometry`: then the template's
    geometry is drawn, which the mod's 12-index buffer differs from."""
    (root/'Meshes').mkdir(parents=True); (root/'Textures').mkdir()
    parts = dict(PANTIES if panties else dict(constants='', keys='', draws=''), vb0='vb0 = Resource_Position' if geometry else '')
    (root/'mod.ini').write_text(SWITCH_INI.format(**parts))
    (root/'Meshes/IB.buf').write_bytes(struct.pack(f'<{len(IB)}H', *IB))
    (root/'Meshes/Position.buf').write_bytes(b''.join(struct.pack('<3fI', *p, 0) for p in MOVED_POSITIONS))
    for name, raw in (('red', RED), ('blue', BLUE), ('green', GREEN)):(root/f'Textures/{name}.dds').write_bytes(raw)
    return root


# CLOTH drawn with a new _BaseMap, and BODY's first submesh with the template's own one (bytes of its binding 7) whose color the
# switch changes: the defaults leave BODY as the template.
BODY_INI = '''[Constants]
global persist $color = 0

[KeyColor]
key = VK_F2
type = cycle
$color = 0, 1, 2

[TextureOverride_Cloth]
hash = 40609654
match_first_index = 0
match_index_count = 6
$\\EFMIv1\\component_id = 0
run = CommandList_Cloth

[CommandList_Cloth]
ps-t0 = ResourceRed
drawindexed = 6, 0, 0

[TextureOverride_Body]
hash = ad2ae6dc
match_first_index = 0
match_index_count = 3
$\\EFMIv1\\component_id = 1
run = CommandList_Body

[CommandList_Body]
if $color == 0
    ps-t0 = ResourceSkin
else if $color == 1
    ps-t0 = ResourceBlue
else
    ps-t0 = ResourceGreen
endif
drawindexed = 3, 0, 0

[ResourceRed]
filename = Textures/red.dds

[ResourceSkin]
filename = Textures/skin.dds

[ResourceBlue]
filename = Textures/blue.dds

[ResourceGreen]
filename = Textures/green.dds
'''
SKIN, SKIN_BLUE, SKIN_GREEN = dds(4, 4, 99, fill=7), dds(4, 4, 99, fill=2), dds(4, 4, 99, fill=3)
# aster-shorter-dress's shape: one texture's full, mid and low hashes each switch the same two files.
COAT_SECTIONS = '''
[Constants]
global persist $coat = 0

[KeyCoat]
key = VK_F1
type = cycle
$coat = 0, 1

[ResourcePlain]
filename = Textures/Components-0 Diffuse NoCoat.dds

[ResourceCoat]
filename = Textures/Components-0 Diffuse.dds
'''+''.join(f'''
[TextureOverride_Texture0{suffix}]
hash = {h}
if $coat == 0
    this = ResourcePlain
endif
if $coat == 1
    this = ResourceCoat
endif
''' for suffix, h in (('', '1234abcd'), ('_mid', '2345bcde'), ('_low', '3456cdef')))


# Mod index buffer IB's draws A (0), B (3), C (6): `upper` blues B and C, `lower` C alone, as si-df68a's two tattoo switches.
TATTOO_INI = '''[Constants]
global persist $upper = 0
global persist $lower = 0

[KeyUpper]
key = VK_F1
type = cycle
$upper = 0, 1

[KeyLower]
key = VK_F2
type = cycle
$lower = 0, 1

[TextureOverride_EntryPoint_LOD0.40609654_6_0]
hash = 40609654
match_first_index = 0
match_index_count = 6
$\\EFMIv1\\component_id = 0
run = CommandList_Draw

[CommandList_Draw]
ib = Resource_IB
vb0 = Resource_Position
ps-t0 = ResourceRed
drawindexed = 3, 0, 0
if $upper == 1
    ps-t0 = ResourceBlue
endif
drawindexed = 3, 3, 0
if $lower != $upper
    if $lower == 0
        ps-t0 = ResourceRed
    else
        ps-t0 = ResourceBlue
    endif
endif
drawindexed = 3, 6, 0

[Resource_IB]
type = Buffer
format = DXGI_FORMAT_R16_UINT
filename = Meshes/IB.buf

[Resource_Position]
type = Buffer
stride = 16
filename = Meshes/Position.buf

[ResourceRed]
filename = Textures/red.dds

[ResourceBlue]
filename = Textures/blue.dds
'''
# CLOTH drawn with a new _BaseMap; BODY's first submesh drawn from the mod's copy of its indices under a switch, nothing bound.
TAIL_INI = '''[Constants]
global persist $tail = 0

[KeyTail]
key = VK_F1
type = cycle
$tail = 0, 1

[TextureOverride_Cloth]
hash = 40609654
match_first_index = 0
match_index_count = 6
$\\EFMIv1\\component_id = 0
run = CommandList_Cloth

[CommandList_Cloth]
ps-t0 = ResourceRed
drawindexed = 6, 0, 0

[TextureOverride_Body]
hash = ad2ae6dc
match_first_index = 0
match_index_count = 3
$\\EFMIv1\\component_id = 1
run = CommandList_Body

[CommandList_Body]
ib = Resource_Body_IB
if $tail == 0
    drawindexed = 3, 0, 0
endif

[Resource_Body_IB]
type = Buffer
format = DXGI_FORMAT_R16_UINT
filename = Meshes/Body_IB.buf

[ResourceRed]
filename = Textures/red.dds
'''


def u16(*indices):return struct.pack(f'<{len(indices)}H', *indices)


def sha(raw):return hashlib.sha256(raw).hexdigest()


class ModSettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.package = package_fixture(self.root/'package', atlas=True)

    def imported(self, mod, name='out'):
        report = import_outfit.import_outfit(self.package.root, mod, self.root/name)
        package = Package(self.root/name); runtime = self.root/name/'runtime'
        entry = package.native_entry
        pack = read_json(runtime/entry['c7']['file'])
        docs = dict(source=read_json(runtime/entry['source']['file']), graph=read_json(runtime/entry['graph']['file']), pack=pack,
                    palette=read_json(runtime/'animation'/pack['animation']['palette_contract']['file']))
        refs = [r for r in pack['interaction']['data'] if r['file'] == 'mod-settings.json']
        table = read_json(runtime/'interaction'/refs[0]['file']) if refs else None
        return report, docs, table, runtime

    def test_two_switches_with_exclusive_segments_and_a_color_variant(self):
        report, docs, table, runtime = self.imported(switch_mod(self.root/'mod'))
        aid = report['appearance']['id']; clone = 'outfit:'+aid+'/'+CLOTH
        entry = table['appearances'][aid]
        self.assertEqual(table['schema'], 'endfield-mod-settings/v1')
        self.assertEqual([(s['id'], s['name'], s['default'], [v['value'] for v in s['values']]) for s in entry['settings']],
                         [('coat', '外套', 0, [0, 1]), ('color', 'color', 0, [0, 1, 2])])
        self.assertEqual(entry['settings'][0]['values'], [dict(value=0, name='选项 1'), dict(value=1, name='选项 2')])
        self.assertEqual(entry['settings'][0]['origin'], dict(section='KeyCoat', variable='$coat', key='VK_F1', type='cycle'))
        self.assertEqual([{k: s[k] for k in ('mesh', 'indices_sha256', 'first', 'count', 'visible_when')} for s in entry['segments']],
                         [dict(mesh=clone, indices_sha256=sha(u16(2, 1, 3)), first=0, count=3, visible_when=dict(coat=[0])),
                          dict(mesh=clone, indices_sha256=sha(u16(1, 2, 3)), first=0, count=3, visible_when=dict(coat=[1]))])
        [texture] = entry['textures']
        self.assertEqual((texture['mesh'], texture['resource']), (clone, '_BaseMap'))
        self.assertEqual([v['when'] for v in texture['variants']], [dict(color=[1]), dict(color=[2])])
        variants = {v['id']: v for v in docs['source']['texture_variants']}
        self.assertEqual([variants[v['variant']]['sha256'] for v in texture['variants']], [sha(BLUE[148:]), sha(GREEN[148:])])
        for v in variants.values():
            self.assertEqual((v['mesh'], v['resource_names']), (clone, ['_BaseMap']))
            self.assertEqual((runtime/'source'/v['file']).read_bytes()[:16], (BLUE if v['sha256'] == sha(BLUE[148:]) else GREEN)[148:164])
        native = read_json(runtime/'bundle.json')
        indexed = {f['file']: f for f in native['files']}
        check_mod_settings(table, {a['id'] for a in docs['pack']['appearances']}, docs['source'],
                           lambda ref: 'source/'+ref['file'] in indexed and indexed['source/'+ref['file']]['sha256'] == ref['sha256'])
        self.assertEqual(report['settings'], dict(settings=2, fixed=[], unused=[], segments=2, variants=2, variant_bytes=2*len(BLUE[148:]), warnings=[]))

    def test_the_defaults_draw_what_the_import_without_a_table_draws(self):
        mod = switch_mod(self.root/'mod')
        with mock.patch.object(mod_settings, 'read', lambda mod: []):
            plain, bare, none, _ = self.imported(mod, 'plain')
        self.assertIsNone(none)
        report, docs, table, _ = self.imported(mod)
        segments = table['appearances'][report['appearance']['id']]['segments']
        def hidden(d):return any(s['mesh'] == d['mesh'] and s['indices_sha256'] == d['indices']['sha256'] and s['first'] == 0 and
                                 s['count'] == d['index_count'] and 0 not in s['visible_when'].get('coat', [0]) for s in segments)
        def drawn(source):return [json.dumps(d, sort_keys=True) for d in source['draws'] if not hidden(d)]
        self.assertEqual(drawn(docs['source']), drawn(bare['source']))
        self.assertEqual(len(docs['source']['draws']), len(bare['source']['draws'])+1)
        self.assertNotIn('texture_variants', bare['source'])

    def test_a_segment_of_an_index_buffer_the_clone_does_not_draw_is_unmappable(self):
        report, docs, table, _ = self.imported(switch_mod(self.root/'mod', geometry=False))
        entry = table['appearances'][report['appearance']['id']]
        self.assertEqual(entry['segments'], [])
        self.assertEqual([s['id'] for s in entry['settings']], ['color'])
        self.assertIn('segment_unmappable:TextureOverride_EntryPoint_LOD0.40609654_6_0', report['settings']['warnings'])
        self.assertIn('segment_unmappable:TextureOverride_EntryPoint_LOD0.40609654_6_0', report['warnings'])
        clone = 'outfit:'+report['appearance']['id']+'/'+CLOTH
        [template] = [d for d in docs['source']['draws'] if d['mesh'] == CLOTH]
        self.assertEqual([d['indices'] for d in docs['source']['draws'] if d['mesh'] == clone], [template['indices']])

    def test_removing_the_appearance_leaves_nothing_of_it(self):
        runtime = self.package.root/'runtime'; entry = self.package.native_entry
        pack = read_json(runtime/entry['c7']['file'])
        original = dict(source=read_json(runtime/entry['source']['file']), graph=read_json(runtime/entry['graph']['file']), pack=pack,
                        palette=read_json(runtime/'animation'/pack['animation']['palette_contract']['file']))
        report, docs, table, _ = self.imported(switch_mod(self.root/'mod'))
        result = outfit_compose.remove_appearance(docs['source'], docs['graph'], docs['palette'], docs['pack'], report['appearance']['id'], mod_settings=table)
        self.assertEqual((result['mod_settings'], len(result['texture_variants'])), ('removed', 2))
        for doc in ('source', 'palette'):self.assertEqual(docs[doc], original[doc])
        self.assertEqual({k: v for k, v in docs['graph'].items() if k != 'manifest_sha256'}, {k: v for k, v in original['graph'].items() if k != 'manifest_sha256'})
        self.assertEqual((docs['pack']['appearances'], [r['file'] for r in docs['pack']['interaction']['data']]),
                         (original['pack']['appearances'], [r['file'] for r in original['pack']['interaction']['data']]))

    def test_removing_an_appearance_that_hid_a_mesh_drops_the_list_it_gave_the_mesh(self):
        runtime = self.package.root/'runtime'; entry = self.package.native_entry
        pack = read_json(runtime/entry['c7']['file'])
        original = read_json(runtime/'animation'/pack['animation']['palette_contract']['file'])
        report, docs, table, _ = self.imported(tools_mod(self.root/'tools'))
        self.assertEqual(next(m for m in docs['palette']['meshes'] if m['mesh'] == CLOTH).get('appearances'), ['default', 'top'])
        outfit_compose.remove_appearance(docs['source'], docs['graph'], docs['palette'], docs['pack'], report['appearance']['id'], mod_settings=table)
        self.assertEqual(docs['palette'], original)

    def test_sections_switching_one_texture_alike_give_one_variant(self):
        files = {'Textures/Components-0 Diffuse NoCoat.dds': dds(4, 4, 99, fill=1), 'Textures/Components-0 Diffuse.dds': dds(4, 4, 99, fill=2)}
        report, docs, table, runtime = self.imported(cloth_mod(self.root/'mod', 'drawindexed = 6, 0, 0', files, COAT_SECTIONS))
        aid = report['appearance']['id']
        [texture] = table['appearances'][aid]['textures']
        self.assertEqual((texture['mesh'], texture['resource'], [v['when'] for v in texture['variants']]),
                         ('outfit:'+aid+'/'+CLOTH, '_BaseMap', [dict(coat=[1])]))
        self.assertEqual([v['id'] for v in docs['source']['texture_variants']], [texture['variants'][0]['variant']])
        native = read_json(runtime/'bundle.json')
        indexed = {f['file']: f for f in native['files']}
        check_mod_settings(table, {a['id'] for a in docs['pack']['appearances']}, docs['source'],
                           lambda ref: 'source/'+ref['file'] in indexed and indexed['source/'+ref['file']]['sha256'] == ref['sha256'])

    def test_the_atlas_casts_the_clone_and_its_segment_blocks(self):
        report, docs, table, _ = self.imported(switch_mod(self.root/'mod'))
        clone = 'outfit:'+report['appearance']['id']+'/'+CLOTH
        [atlas] = [p for p in docs['graph']['passes'] if p['id'] == 'character-atlas']
        cast = {(e['mesh'], e['indices']['sha256']) for e in atlas['geometry']}
        segments = table['appearances'][report['appearance']['id']]['segments']
        self.assertTrue({(s['mesh'], s['indices_sha256']) for s in segments} <= cast)
        self.assertIn((clone, sha(u16(0, 1, 2))), cast)

    def test_an_underwear_switch_is_fixed_where_it_draws_most_and_not_listed(self):
        report, docs, table, _ = self.imported(switch_mod(self.root/'mod', panties=True))
        entry = table['appearances'][report['appearance']['id']]
        self.assertEqual([s['id'] for s in entry['settings']], ['coat', 'color'])
        self.assertIn('setting_fixed:panties', report['settings']['warnings'])
        self.assertIn('setting_fixed:panties', report['warnings'])
        self.assertEqual(report['settings']['fixed'], ['panties'])
        clone = 'outfit:'+report['appearance']['id']+'/'+CLOTH
        blocks = {d['indices']['sha256'] for d in docs['source']['draws'] if d['mesh'] == clone}
        # The mod's default hides P; the most drawn value shows it, always.
        self.assertIn(sha(u16(0, 2, 1)), blocks)
        self.assertNotIn(sha(u16(0, 2, 1)), {s['indices_sha256'] for s in entry['segments']})
        for word in ('$show_panties', 'KeyBra', 'UnderwearToggle', '内衣', 'NUDE', 'lingerie_on', '胸罩'):self.assertTrue(mod_settings.adult(word), word)
        for word in ('$library', 'zebra', 'KeyBrace', 'coat', '外套'):self.assertFalse(mod_settings.adult(word), word)

    def test_a_switch_through_a_derived_variable_masks_a_run_of_its_group(self):
        # aster-toggle's shape: a list the key does not run sets the drawing variable from the key's.
        ini = SWITCH_INI.format(constants='global $draw_b = 1\n', keys='\n[CommandListProcess]\n$draw_b = ($coat == 0)\n',
                                vb0='vb0 = Resource_Position', draws='').replace('if $coat == 0\n    drawindexed = 3, 3, 0\nelse\n    drawindexed = 3, 6, 0\nendif',
                                                                               'if $draw_b\n    drawindexed = 3, 3, 0\nendif')
        mod = switch_mod(self.root/'mod'); (mod/'mod.ini').write_text(ini)
        report, docs, table, _ = self.imported(mod)
        clone = 'outfit:'+report['appearance']['id']+'/'+CLOTH
        segments = table['appearances'][report['appearance']['id']]['segments']
        self.assertEqual([{k: s[k] for k in ('mesh', 'indices_sha256', 'first', 'count', 'visible_when')} for s in segments],
                         [dict(mesh=clone, indices_sha256=sha(u16(0, 1, 2, 2, 1, 3)), first=3, count=3, visible_when=dict(coat=[0]))])

    def test_a_one_level_variant_gets_the_twelve_levels_of_its_slot(self):
        mips, offset = [], 0
        for level in range(12):
            w, h = max(1, 2048 >> level), max(1, 4 >> level)
            mips.append(dict(level=level, width=w, height=h, offset=offset, size=(w+3)//4*((h+3)//4)*16)); offset += mips[-1]['size']
        slot = dict(category='separate_images', names=['_BaseMap'], texture=dict(name='T_hair', dimension='2D', width=2048, height=4, mip_count=12,
                                                                                    storage_color_space_raw=1, rd_format_name='BC7_SRGB_BLOCK', mips=mips))
        source = dict(draws=[dict(mesh='outfit:a/'+CLOTH, resources=[slot])])
        path = self.root/'blue.dds'; path.write_bytes(dds(2048, 4, 99, fill=2))
        stored, warnings = {}, []
        def put(raw):stored[sha(raw)] = raw; return dict(file='Files/'+sha(raw)+'.bytes', sha256=sha(raw), byte_count=len(raw))
        entries, textures, size = mod_settings.place_variants('a', source, [('color', 1, 'outfit:a/'+CLOTH, '_BaseMap', 'blue.dds', None)],
                                                              lambda f: efmi_mod.read_dds(self.root/f), put, warnings.append)
        self.assertEqual(warnings, [])
        [entry] = entries
        self.assertEqual({k: entry['texture'][k] for k in ('width', 'height', 'mip_count', 'rd_format_name', 'mips', 'dimension')},
                         dict(width=2048, height=4, mip_count=12, rd_format_name='BC7_SRGB_BLOCK', mips=mips, dimension='2D'))
        raw = stored[entry['sha256']]
        self.assertEqual((len(raw), size), (offset, offset))
        self.assertEqual(raw[:2048//4*16], dds(2048, 4, 99, fill=2)[148:])

    def test_a_mesh_the_defaults_leave_as_the_template_is_cloned_for_its_variants(self):
        mod = self.root/'mod'; (mod/'Textures').mkdir(parents=True); (mod/'mod.ini').write_text(BODY_INI)
        for name, raw in (('red', RED), ('skin', SKIN), ('blue', SKIN_BLUE), ('green', SKIN_GREEN)):(mod/f'Textures/{name}.dds').write_bytes(raw)
        report, docs, table, runtime = self.imported(mod)
        self.assertEqual([w for w in report['settings']['warnings'] if w.startswith('variant_unplaced')], [])
        aid = report['appearance']['id']; clone = 'outfit:'+aid+'/'+BODY
        templates = [d for d in docs['source']['draws'] if d['mesh'] == BODY]
        clones = [d for d in docs['source']['draws'] if d['mesh'] == clone]
        # The clone draws the template's bytes, its textures too.
        self.assertEqual([dict(d, mesh=BODY) for d in clones], templates)
        [texture] = table['appearances'][aid]['textures']
        self.assertEqual((texture['mesh'], texture['resource'], [v['when'] for v in texture['variants']]), (clone, '_BaseMap', [dict(color=[1]), dict(color=[2])]))
        variants = {v['id']: v for v in docs['source']['texture_variants']}
        for v, raw in zip(texture['variants'], (SKIN_BLUE, SKIN_GREEN)):
            variant = variants[v['variant']]
            self.assertEqual({k: variant['texture'][k] for k in ('mip_count', 'mips')}, {k: templates[0]['resources'][0]['texture'][k] for k in ('mip_count', 'mips')})
            self.assertEqual((runtime/'source'/variant['file']).read_bytes()[:16], raw[148:])
        self.assertEqual({m['mesh']: m.get('appearances') for m in docs['palette']['meshes'] if BODY in m['mesh']},
                         {BODY: ['default', 'top'], clone: [aid]})

    def test_key_presses_name_the_values_and_ids(self):
        ini = '''[Constants]
global persist $swapkey17 = 0
global $x = 0

[KeySwap_18]
; 耳坠
key = ALT 7
run = CommandListToggle17

[KeyBack]
key = VK_F4
type = toggle
$Foo.Bar = 1

[CommandListToggle17]
$swapkey17 = $swapkey17 + 1
if $swapkey17 > 2
    $swapkey17 = 0
endif
'''
        root = self.root/'keys'; root.mkdir(); (root/'mod.ini').write_text(ini)
        settings = mod_settings.read(efmi_mod.load_mod(root))
        self.assertEqual([(s.id, s.name, s.states) for s in settings],
                         [('swapkey17', '耳坠', [{}, {'$swapkey17': 1.0}, {'$swapkey17': 2.0}]), ('foo_bar', 'foo.bar', [{}, {'$foo.bar': 1.0}])])
        self.assertEqual(mod_settings.setting_id('$9lives', {'lives'}), 'lives_2')

    def test_a_key_without_a_comment_is_named_after_its_panel_icon_then_its_variable(self):
        # si-df68a's res_panel: the panel binds a switch's icon, then reads the switch's variable.
        ini = '''[Constants]
global persist $swapkey17 = 0
global persist $swapkey19 = 0
global persist $swapkey26 = 0
global persist $si2_upper = 0

[KeySwap_18]
; 耳坠
key = ALT 7
run = CommandListToggle17

[KeySwap_20]
key = CTRL 7
run = CommandListToggle19

[KeySwap_25]
key = ALT 8
run = CommandListToggle26

[KeySisi_upper]
key = ALT CTRL 8
run = CommandListToggleUpper

[CommandListToggle17]
$swapkey17 = 1 - $swapkey17

[CommandListToggle19]
$swapkey19 = 1 - $swapkey19

[CommandListToggle26]
$swapkey26 = 1 - $swapkey26

[CommandListToggleUpper]
$si2_upper = 1 - $si2_upper

[CommandListPanel]
ps-t100 = ResourceIcon32
$si_state = $swapkey17
ps-t100 = ResourceIcon13
$si_state = $swapkey19
ps-t100 = ResourceIcon44
$si_state = $swapkey26
if $si_state == 0
    ps-t100 = ResourceToggleOn
endif
$si_x = $si_x + 200

[ResourceIcon32]
filename = res_panel/32_earrings.png

[ResourceIcon13]
filename = res_panel/13_panties.png

[ResourceIcon44]
filename = res_panel/44_tshirt.png

[ResourceToggleOn]
filename = res_panel/toggle_on.png
'''
        root = self.root/'panel'; (root/'res_panel').mkdir(parents=True); (root/'mod.ini').write_text(ini)
        for name in ('32_earrings', '13_panties', '44_tshirt', 'toggle_on'):(root/'res_panel'/(name+'.png')).write_bytes(b'\x89PNG')
        settings = mod_settings.read(efmi_mod.load_mod(root))
        self.assertEqual([(s.id, s.name, s.icon, s.adult) for s in settings],
                         [('swapkey17', '耳坠', '32_earrings', False), ('swapkey19', 'panties', '13_panties', True),
                          ('swapkey26', 'tshirt', '44_tshirt', False), ('si2_upper', 'si2_upper', None, False)])

    def test_a_switch_is_sorted_by_its_segments_textures_and_words(self):
        def setting(sid, name, icon=None):return mod_settings.Setting(sid, name, dict(variable='$'+sid), [{}, {'$'+sid: 1.0}], icon=icon)
        def segment(mesh, sid):return dict(mesh='outfit:mod_a/S_actor_test_'+mesh+'_lod0', indices_sha256='0'*64, first=0, count=3, visible_when={sid: [0]})
        settings = [setting('tint', '外套颜色'), setting('bangs', '外套'), setting('swapkey17', '耳坠'), setting('swapkey26', 'swapkey26', '44_tshirt'),
                    setting('lip_colour', 'lip_colour'), setting('toggle_0', 'toggle_0'), setting('cape', '披风')]
        segments = [segment('hair_01', 'bangs'), segment('hairshadow_01', 'bangs'), segment('cloth_01', 'swapkey17'), segment('cloth_01', 'swapkey26'),
                    segment('cloth_02', 'lip_colour'), segment('cloth_02', 'toggle_0'), segment('hair_01', 'cape'), segment('cloth_01', 'cape')]
        textures = [dict(mesh='outfit:mod_a/S_actor_test_cloth_01_lod0', resource='_BaseMap', variants=[dict(variant='v', when=dict(tint=[1]))])]
        entry = mod_settings.entry(mod_settings.Plan(settings), segments, textures)
        self.assertEqual([(s['id'], s['category']) for s in entry['settings']],
                         [('tint', 'color'), ('bangs', 'hair'), ('swapkey17', 'accessory'), ('swapkey26', 'clothing'), ('lip_colour', 'color'),
                          ('toggle_0', 'other'), ('cape', 'other')])

    def test_values_are_named_after_their_resources_or_as_shown_and_hidden(self):
        ini = SWITCH_INI.format(constants='global persist $cape = 0\n', keys='\n[KeyCape]\nkey = VK_F3\ntype = cycle\n$cape = 0, 1\n',
                                vb0='vb0 = Resource_Position', draws='if $cape == 0\n    drawindexed = 3, 9, 0\nendif')
        for color in ('Red', 'Blue', 'Green'):ini = ini.replace('Resource'+color, 'Resource_Tint_'+color)
        mod = switch_mod(self.root/'mod'); (mod/'mod.ini').write_text(ini)
        report, docs, table, _ = self.imported(mod)
        entry = table['appearances'][report['appearance']['id']]
        self.assertEqual([(s['id'], s['category'], [v['name'] for v in s['values']]) for s in entry['settings']],
                         [('coat', 'clothing', ['选项 1', '选项 2']), ('color', 'color', ['Red', 'Blue', 'Green']), ('cape', 'other', ['显示', '隐藏'])])

    def test_a_switch_of_part_of_a_group_swaps_the_texture_of_that_part_only(self):
        # si-df68a's 纹样: one switch binds another file for the draws after it, the other for the last draw only.
        mod = switch_mod(self.root/'mod'); (mod/'mod.ini').write_text(TATTOO_INI)
        report, docs, table, runtime = self.imported(mod)
        aid = report['appearance']['id']; clone = 'outfit:'+aid+'/'+CLOTH
        self.assertEqual([w for w in report['warnings'] if w.startswith(('variant_unplaced', 'segment_unmappable'))], [])
        entry = table['appearances'][aid]
        self.assertEqual([s['id'] for s in entry['settings']], ['upper', 'lower'])
        # A, B and C bind red by default; B and C are drawn apart from A, each in a block of its own.
        blocks = {d['indices']['sha256'] for d in docs['source']['draws'] if d['mesh'] == clone}
        self.assertEqual(blocks, {sha(u16(0, 1, 2)), sha(u16(2, 1, 3)), sha(u16(1, 2, 3))})
        self.assertEqual([(t['mesh'], t['indices_sha256'], t['resource'], [v['when'] for v in t['variants']]) for t in entry['textures']],
                         [(clone, sha(u16(2, 1, 3)), '_BaseMap', [dict(upper=[1])]), (clone, sha(u16(1, 2, 3)), '_BaseMap', [dict(lower=[1])])])
        variants = {v['id']: v for v in docs['source']['texture_variants']}
        self.assertEqual({variants[v['variant']]['sha256'] for t in entry['textures'] for v in t['variants']}, {sha(BLUE[148:])})
        native = read_json(runtime/'bundle.json')
        indexed = {f['file']: f for f in native['files']}
        check_mod_settings(table, {a['id'] for a in docs['pack']['appearances']}, docs['source'],
                           lambda ref: 'source/'+ref['file'] in indexed and indexed['source/'+ref['file']]['sha256'] == ref['sha256'])

    def test_a_switch_of_a_mesh_the_defaults_leave_as_the_template_hides_its_clone(self):
        # si-df68a's tail fur: the mod draws the template's own indices, under a switch, and binds no texture of its own.
        mod = self.root/'mod'; (mod/'Textures').mkdir(parents=True); (mod/'Meshes').mkdir()
        (mod/'mod.ini').write_text(TAIL_INI); (mod/'Textures/red.dds').write_bytes(RED); (mod/'Meshes/Body_IB.buf').write_bytes(u16(0, 1, 2))
        report, docs, table, _ = self.imported(mod)
        self.assertEqual([w for w in report['warnings'] if w.startswith('segment_unmappable')], [])
        aid = report['appearance']['id']; clone = 'outfit:'+aid+'/'+BODY
        self.assertEqual([{k: s[k] for k in ('mesh', 'indices_sha256', 'first', 'count', 'visible_when')} for s in table['appearances'][aid]['segments']],
                         [dict(mesh=clone, indices_sha256=sha(u16(0, 1, 2)), first=0, count=3, visible_when=dict(tail=[0]))])


if __name__ == '__main__':
    unittest.main()
