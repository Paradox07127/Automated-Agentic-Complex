"""Which texture a draw of an EFMI mod sees, by the XXMI runtime's rules; synthetic inis only: no byte of a user mod or of game data."""
from pathlib import Path
import struct
import sys
import tempfile
import unittest

CHARACTERS = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(CHARACTERS)]
from agentic_complex_build import efmi_mod

CHECK = 'run = CommandList\\EFMIv1\\OverrideTextures'


def dds(dxgi=98):
    """A DDS header with a DX10 header naming `dxgi`, enough for its format to be read."""
    header = bytearray(124)
    struct.pack_into('<7I', header, 0, 124, 0x1007, 4, 4, 0, 0, 1)
    struct.pack_into('<2I4s', header, 72, 32, 0x4, b'DX10')
    return b'DDS '+bytes(header)+struct.pack('<5I', dxgi, 3, 0, 1, 0)+bytes(16)


def component(body, cid=0, h='1111aaaa', count=30, first=None):
    """A component entry point of index count `count` running its draw list `body`."""
    return (f'\n[TextureOverride_Component{cid}]\nhash = {h}\nmatch_index_count = {count}\n'
            + (f'match_first_index = {first}\n' if first is not None else '')
            + f'$\\EFMIv1\\component_id = {cid}\nrun = CommandList_Draw{cid}\n\n[CommandList_Draw{cid}]\n{body}\n')


def resources(*names):
    """[Resource<N>] sections of Textures/<n>.dds, and the files they name."""
    return ''.join(f'\n[Resource{n}]\nfilename = Textures/{n.lower()}.dds\n' for n in names), [f'Textures/{n.lower()}.dds' for n in names]


class Semantics(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def mod(self, ini, files=(), name='mod', extra=()):
        """The mod folder `name` with mod.ini `ini`, a DDS at each of `files`, and each (path, text) of `extra`."""
        root = self.root/name
        for path, text in (('mod.ini', ini), *extra):
            (root/path).parent.mkdir(parents=True, exist_ok=True); (root/path).write_text(text)
        for f in files:
            (root/f).parent.mkdir(parents=True, exist_ok=True); (root/f).write_bytes(dds())
        return efmi_mod.load_mod(root)

    def textures(self, mod, cid=0, values=None, slot_formats=None):
        components = mod.components if values is None and slot_formats is None else efmi_mod.components(mod, values, slot_formats)
        return [s.textures for s in components[cid].segments]

    def spans(self, components, cid=0):
        return [(s.first, s.count) for s in components[cid].segments]

    # 1. Texture overrides fire only at a texture check.

    def test_the_override_last_in_match_priority_then_section_name_order_decides_a_hash(self):
        text, files = resources('A', 'B', 'C', 'D')
        ini = component('ResourceSelA = ref ResourceA\nResourceSelB = ref ResourceB\nResourceSelC = ref ResourceC\n'
                        'ResourceSelD = ref ResourceD\n'+CHECK+'\ndrawindexed = 30, 0, 0') + text + '''
[ResourceSelA]
[ResourceSelB]
[ResourceSelC]
[ResourceSelD]

[TextureOverrideHigh]
hash = 2222bbbb
match_priority = 1
this = ref ResourceSelA

[TextureOverrideLow]
hash = 2222bbbb
this = ref ResourceSelB

[TextureOverrideZ]
hash = 3333cccc
this = ref ResourceSelC

[TextureOverrideY]
hash = 3333cccc
this = ref ResourceSelD
'''
        [textures] = self.textures(self.mod(ini, files))
        self.assertEqual(textures['hash:2222bbbb'], (('Textures/a.dds', ()),))
        self.assertEqual(textures['hash:3333cccc'], (('Textures/c.dds', ()),))

    def test_a_this_inside_an_if_and_inside_a_called_list_follows_the_values(self):
        text, files = resources('A', 'B', 'C')
        ini = '[Constants]\nglobal persist $skin = 0\n' + component(CHECK+'\ndrawindexed = 30, 0, 0') + text + '''
[TextureOverrideCalled]
hash = 4444dddd
run = CommandListSkin

[CommandListSkin]
if $skin == 1
    this = ResourceA
else
    this = ResourceB
endif

[TextureOverrideInline]
hash = 5555eeee
if $skin == 1
    this = null
endif
'''
        mod = self.mod(ini, files)
        [default] = self.textures(mod)
        self.assertEqual(default['hash:4444dddd'], (('Textures/b.dds', ()),))
        self.assertNotIn('hash:5555eeee', default)
        [skin] = self.textures(mod, values={'$skin': 1})
        self.assertEqual(skin['hash:4444dddd'], (('Textures/a.dds', ()),))
        self.assertEqual(skin['hash:5555eeee'], ((None, ()),))

    def test_an_override_s_match_index_count_and_first_index_pick_the_components_it_fires_at(self):
        text, files = resources('A', 'B')
        body = 'ResourceSel = ref ResourceA\nResourceFirst = ref ResourceB\n'+CHECK+'\ndrawindexed = {n}, 0, 0'
        ini = component(body.format(n=30), 0, '1111aaaa', 30, first=0) + component(body.format(n=60), 1, '6666ffff', 60, first=30) + text + '''
[ResourceSel]
[ResourceFirst]

[TextureOverrideByCount]
hash = 7777aaaa
match_index_count = 30
this = ref ResourceSel

[TextureOverrideByFirst]
hash = 8888bbbb
match_first_index = 30
this = ref ResourceFirst
'''
        mod = self.mod(ini, files)
        [zero], [one] = self.textures(mod, 0), self.textures(mod, 1)
        self.assertEqual((zero.get('hash:7777aaaa'), one.get('hash:7777aaaa')), ((('Textures/a.dds', ()),), None))
        self.assertEqual((zero.get('hash:8888bbbb'), one.get('hash:8888bbbb')), (None, (('Textures/b.dds', ()),)))

    def test_a_draw_after_no_texture_check_gets_no_hash_texture(self):
        text, files = resources('A')
        override = '\n[ResourceSel]\n\n[TextureOverrideTex]\nhash = 2222bbbb\nthis = ref ResourceSel\n'
        unchecked = self.mod(component('ResourceSel = ref ResourceA\ndrawindexed = 30, 0, 0') + text + override, files, 'unchecked')
        self.assertEqual(self.textures(unchecked), [{}])
        own = self.mod(component('ResourceSel = ref ResourceA\ncheckTextureOverride = ps-t3\ndrawindexed = 30, 0, 0') + text + override, files, 'own')
        self.assertEqual(self.textures(own), [{'hash:2222bbbb': (('Textures/a.dds', ()),)}])

    def test_efmi_restores_the_slots_and_hash_textures_after_the_custom_draw_callback(self):
        text, files = resources('A', 'B')
        ini = '''
[TextureOverride_Component0]
hash = 1111aaaa
match_index_count = 30
$\\EFMIv1\\component_id = 0
ps-t1 = ResourceB
CommandList\\EFMIv1\\Callback_Component_DrawCustom = ref CommandList_Draw0
run = CommandList\\EFMIv1\\Component_DrawInstances
drawindexed = 30, 0, 0

[CommandList_Draw0]
ps-t0 = ResourceA
ps-t1 = null
''' + CHECK + '\ndrawindexed = 30, 0, 0\n' + text + '\n[TextureOverrideTex]\nhash = 2222bbbb\nthis = ResourceA\n'
        inner, after = self.textures(self.mod(ini, files))
        self.assertEqual(inner, {'ps-t0': (('Textures/a.dds', ()),), 'ps-t1': ((None, ()),), 'hash:2222bbbb': (('Textures/a.dds', ()),)})
        self.assertEqual(after, {'ps-t1': (('Textures/b.dds', ()),)})
        # Component_DrawInstances_NoDecomposition runs the callback with no snapshot around it.
        bare = ini.replace('Component_DrawInstances', 'Component_DrawInstances_NoDecomposition')
        inner, after = self.textures(self.mod(bare, files, 'bare'))
        self.assertEqual(after, inner)

    # 2. Hash text.

    def test_a_hash_is_read_as_the_runtime_reads_it_and_a_section_of_no_hex_hash_is_skipped(self):
        ini = component('drawindexed = 30, 0, 0', 0, '0x0000ABCD') + component('drawindexed = 6, 0, 0', 1, 'abc', 6) + \
            component('drawindexed = 9, 0, 0', 2, '12g4', 9)
        mod = self.mod(ini)
        self.assertEqual([(o.section, o.hash) for o in mod.overrides], [('TextureOverride_Component0', '0000abcd'), ('TextureOverride_Component1', '00000abc')])
        self.assertEqual(sorted(mod.components), [0, 1])

    # 3. Filter slots.

    def test_a_filter_slot_binds_under_its_dhash_format_and_distance(self):
        text, files = resources('Texture0', 'Texture1')
        ini = component('ps-t[FilterTexture0] = ref ResourceTexture0\nps-t[FilterTexture1] = ResourceTexture1\n'
                        'ps-t[$slot] = ref ResourceTexture1\nps-t[NoFilter] = ref ResourceTexture1\ndrawindexed = 30, 0, 0') + text + '''
[FilterTexture0]
match_format = bc7_unorm_srgb
match_dhash = 8cb4796369a42c84

[FilterTexture1]
match_dhash = 0xFF
match_confidence = 0.9

[NoFilter]
match_format = BC7_UNORM
'''
        mod = self.mod(ini, files)
        zero, one = 'filter:8cb4796369a42c84:BC7_UNORM_SRGB:16', 'filter:00000000000000ff::6'
        self.assertEqual(self.textures(mod), [{zero: (('Textures/texture0.dds', ()),), one: (('Textures/texture1.dds', ()),)}])
        self.assertEqual([(t.slot, t.filename) for t in mod.slot_textures], [(zero, 'Textures/texture0.dds'), (one, 'Textures/texture1.dds')])

    # 4. Toggles.

    def test_toggles_derive_what_draws_from_the_swap_vars_at_the_defaults_and_at_other_values(self):
        ini = '''[Constants]
global $mod_id = -1000
global $mod_enabled = 0
global $object_detected = 0
global persist $swapvar_scarf = 0
global $draw_hat = 1
global $draw_scarf = 1

[Present]
if $object_detected
    if $mod_enabled
        post $object_detected = 0
        run = CommandListProcessToggles
    else
        if $mod_id == -1000
            run = CommandListRegisterMod
        endif
    endif
endif

[CommandListRegisterMod]
run = CommandList\\EFMIv1\\RegisterMod
$mod_id = $\\EFMIv1\\mod_id
if $mod_id >= 0
    $mod_enabled = 1
endif

[CommandListProcessToggles]
$draw_hat = ($swapvar_scarf == 0)
$draw_scarf = ($swapvar_scarf == 1)

[TextureOverride_EntryPoint_Component0]
hash = 1111aaaa
match_index_count = 6
$object_detected = 1
if $mod_enabled
    $\\EFMIv1\\component_id = 0
    run = CommandList_Draw_Component0
endif

[CommandList_Draw_Component0]
if $draw_hat
    drawindexed = 3, 0, 0
endif
if $draw_scarf
    drawindexed = 3, 3, 0
endif
'''
        mod = self.mod(ini)
        self.assertEqual(self.spans(mod.components), [(0, 3)])
        self.assertEqual((mod.defaults['$draw_hat'], mod.defaults['$draw_scarf']), (1.0, 0.0))
        self.assertEqual(self.spans(efmi_mod.components(mod, {'$swapvar_scarf': 1})), [(3, 3)])

    # 5. Recursive inis.

    def test_the_inis_of_every_subfolder_load_in_the_runtime_s_order_but_disabled_ones(self):
        ini = component('ps-t0 = ResourceSub\ndrawindexed = 30, 0, 0')
        extra = [('b.ini', '[ResourceB]\nfilename = b.dds\n'), ('Sub/sub.ini', '[ResourceSub]\nfilename = Tex/sub.dds\n'),
                 ('a/a.ini', '[ResourceLower]\nfilename = ../b.dds\n'), ('DISABLED_Old/old.ini', component('drawindexed = 3, 0, 0', 1, '2222bbbb', 3)),
                 ('disabled.ini', '[ResourceGone]\n'), ('desktop.ini', '[ResourceDesk]\n'), ('Upper.INI', '[ResourceUpper]\n')]
        (self.root/'mod/Sub/Tex').mkdir(parents=True); (self.root/'mod/Sub/Tex/sub.dds').write_bytes(dds())
        mod = self.mod(ini, ['b.dds'], extra=extra)
        self.assertEqual([p.relative_to(self.root/'mod').as_posix() for p in mod.inis], ['b.ini', 'mod.ini', 'a/a.ini', 'Sub/sub.ini'])
        self.assertEqual(sorted(mod.components), [0])
        self.assertEqual(self.textures(mod), [{'ps-t0': (('Sub/Tex/sub.dds', ()),)}])
        self.assertEqual(sorted(mod.files), ['Sub/Tex/sub.dds', 'a/../b.dds', 'b.dds'])

    # 6. Comments.

    def test_only_a_line_starting_with_a_semicolon_is_a_comment(self):
        ini = component('; [mesh:Hat] [vertex_count:3]\ndrawindexed = 30, 0, 0') + \
            component('drawindexed = 6, 0, 0', 1, '2222bbbb ; hat', 6) + '\n; The hat colour\n[KeyHat] ; F1\nkey = VK_F1 ; the key\n'
        mod = self.mod(ini)
        self.assertEqual([o.hash for o in mod.overrides], ['1111aaaa'])
        [key] = mod.keys
        self.assertEqual((key['section'], key['key']), ('KeyHat', 'VK_F1 ; the key'))
        self.assertEqual(next(s.comment for s in mod.sections if s.name == 'KeyHat'), 'The hat colour')
        self.assertEqual([d.entry.part for d in mod.overrides[0].draws], ['Hat'])

    # 7. Slot format.

    def test_an_unbound_slot_s_format_is_minus_two(self):
        ini = component('ps-t5 = null\nif ps-t5->format == -2\n    drawindexed = 3, 0, 0\nendif\n'
                        'if ps-t7->format == -2\n    drawindexed = 3, 3, 0\nendif\nif ps-t0->format == 98\n    drawindexed = 3, 6, 0\nendif')
        mod = self.mod(ini)
        self.assertEqual(self.spans(mod.components), [(0, 3), (3, 3), (6, 3)])
        self.assertEqual(self.spans(efmi_mod.components(mod, None, {'ps-t0': 98})), [(0, 3), (3, 3), (6, 3)])
        self.assertEqual(self.spans(efmi_mod.components(mod, None, {'ps-t7': 98})), [(0, 3)])

    # 8. Color space.

    def test_a_resource_s_color_space_is_kept_by_its_file(self):
        ini = component('drawindexed = 30, 0, 0') + '''
[ResourceA]
filename = Textures\\a.dds
color_space = sRGB

[ResourceB]
filename = Textures/b.dds
color_space = LINEAR

[ResourceC]
filename = Textures/c.dds
'''
        mod = self.mod(ini, ['Textures/a.dds', 'Textures/b.dds', 'Textures/c.dds'])
        self.assertEqual(mod.color_spaces, {'Textures/a.dds': 'srgb', 'Textures/b.dds': 'linear'})


if __name__ == '__main__':
    unittest.main()
