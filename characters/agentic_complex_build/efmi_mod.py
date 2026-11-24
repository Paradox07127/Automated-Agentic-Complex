"""Read an EFMI mod folder (its .ini files, .buf buffers, .dds textures) as data; nothing in the mod is ever executed.

Standard library only: this module ships in the app's content.
"""
from dataclasses import dataclass, field
import functools
import json
import operator
import os
from pathlib import Path
import re
import struct

from .outfit_compose import TextureBlob

MAX_FILE_BYTES = 256 * 2**20
MAX_TOTAL_BYTES = 2**30
# DXGI_FORMAT values of a DDS DX10 header -> the renderer's rd_format_name.
DXGI_FORMATS = {98: 'BC7_UNORM_BLOCK', 99: 'BC7_SRGB_BLOCK', 83: 'BC5_UNORM_BLOCK', 95: 'BC6H_UFLOAT_BLOCK',
                77: 'BC3_UNORM_BLOCK', 78: 'BC3_SRGB_BLOCK', 28: 'R8G8B8A8_UNORM', 29: 'R8G8B8A8_SRGB'}
# Legacy FourCCs of a DDS without a DX10 header; mods write BC5 and BC3 this way.
FOURCC_FORMATS = {b'BC5U': 'BC5_UNORM_BLOCK', b'ATI2': 'BC5_UNORM_BLOCK', b'DXT5': 'BC3_UNORM_BLOCK'}
FOURCC_DXGI = {b'BC5U': 83, b'ATI2': 83, b'DXT5': 77}
# An uncompressed DDS without a DX10 header: DDPF_RGB with 32 bits in R, G, B, A byte order.
RGBA_MASKS = (32, 0xff, 0xff00, 0xff0000, 0xff000000)
BEM_MAGIC = b'BEM\0PKG\0'
EFF = 'unsupported_mod:EFF 格式（[Mod] format=）替换的是游戏资源文件，不是 EFMI 的绘制调用'
CONTROL = {'if', 'elif', 'else', 'endif'}
# The exporter's `; [mesh:<part>] [vertex_count:N]` comment above a draw call.
PART = re.compile(r'\[mesh:([^\]]*)\]')
SKELETON = re.compile(r'\$(\S+)\[(.+)\]')
# EFMI's pool inputs by their binding (`Pool\EFMIv1\Input_… = ref <pool>`) and by the template's own pool names.
POOL_INPUT = 'pool\\efmiv1\\input_mergedskeleton_component_vertexgroup'
TEMPLATE_POOL = 'pool_mergedskeleton_component_vertexgroup'
# (slot family, stride) -> (semantic, format, offset) per element: the birch/VoiceA stride families of the samples.
STRIDE_LAYOUTS = {
    ('vb0', 12): [('POSITION0', 'R32G32B32_FLOAT', 0)],
    ('vb0', 16): [('POSITION0', 'R32G32B32_FLOAT', 0), ('ENCODEDDATA0', 'R32_UINT', 12)],
    ('vb0', 24): [('POSITION0', 'R32G32B32_FLOAT', 0), ('NORMAL0', 'R32G32B32_FLOAT', 12)],
    ('vb1', 8): [('TEXCOORD0', 'R32G32_FLOAT', 0)],
    ('vb1', 12): [('TEXCOORD0', 'R32G32_FLOAT', 0), ('COLOR0', 'R8G8B8A8_SNORM', 8)],
    ('vb1', 16): [('TEXCOORD0', 'R32G32_FLOAT', 0), ('TEXCOORD1', 'R32G32_FLOAT', 8)],
    ('vb1', 20): [('TEXCOORD0', 'R32G32_FLOAT', 0), ('TEXCOORD1', 'R32G32_FLOAT', 8), ('COLOR0', 'R8G8B8A8_SNORM', 16)],
    # Merged-skeleton family (global u16 bone ids) and local family (u8 ids into the mesh's own bones); 8 and 4 carry ids only.
    ('vb2', 16): [('BLENDWEIGHTS0', 'R16G16B16A16_UNORM', 0), ('BLENDINDICES0', 'R16G16B16A16_UINT', 8)],
    ('vb2', 8): [('BLENDINDICES0', 'R16G16B16A16_UINT', 0)],
    ('vb2', 12): [('BLENDWEIGHTS0', 'R16G16B16A16_UNORM', 0), ('BLENDINDICES0', 'R8G8B8A8_UINT', 8)],
    ('vb2', 4): [('BLENDINDICES0', 'R8G8B8A8_UINT', 0)],
    ('vb2', 24): [('BLENDWEIGHTS0', 'R32G32B32A32_FLOAT', 0), ('BLENDINDICES0', 'R16G16B16A16_UINT', 16)],
}
# The EFMI library command lists (by name prefix) that call back into the mod, with the callbacks each one runs, in order.
CALLBACKS = {'commandlist\\efmiv1\\component_drawinstances': ('commandlist\\efmiv1\\callback_mergedskeleton_connectcomponent',
                                                             'commandlist\\efmiv1\\callback_component_drawcustom'),
             'commandlist\\efmiv1\\shapekeys_apply': ('commandlist\\efmiv1\\callback_shapekeys_attachcomponent',)}
REGISTER = 'commandlist\\efmiv1\\registermod'
# EFMI's list of CheckTextureOverride ps-t0..22, and the mod callback EFMI restores every slot after, per instance.
OVERRIDE_TEXTURES = 'commandlist\\efmiv1\\overridetextures'
DRAW_CUSTOM = 'commandlist\\efmiv1\\callback_component_drawcustom'
SHAPEKEY_SETTER = 'customshader\\efmiv1\\shapekeysetter'
# Custom shader kinds, the one that weighs most for a component first; `state` only changes render state.
KINDS = ('geometry', 'pixel_effect', '2d_panel', 'compute')
STREAM = re.compile(r'ib|vb\d+')
SLOT = re.compile(r'ps-t\d+')
FILTER_SLOT = re.compile(r'ps-t\[\s*([^\]]*?)\s*\]')
# What 3DMigoto's `%16llx` reads as a whole hash value.
HEX = re.compile(r'(?:0x)?[0-9a-f]+', re.IGNORECASE)
ELEMENT_FORMAT = re.compile(r'(vb\d+)->elementformat\(\s*([a-z]+)\s*,\s*(\d+)\s*\)')
TOKEN = re.compile(r'\s*(?:(\d+(?:\.\d*)?|\.\d+)|([a-z]{2}-t\d+)->format\b|(\$[\\\w.]+(?:\[[^\]]*\])?)|(==|!=|<=|>=|&&|\|\||[-+*/%<>!()])'
                   r'|([a-z_]\w*(?:(?:->|-)\w+)*(?:\([^)]*\))?))', re.IGNORECASE)
BINARY = (('||',), ('&&',), ('==', '!='), ('<', '<=', '>', '>='), ('+', '-'), ('*', '/', '%'))
OPERATORS = {'==': operator.eq, '!=': operator.ne, '<': operator.lt, '<=': operator.le, '>': operator.gt, '>=': operator.ge,
             '+': operator.add, '-': operator.sub, '*': operator.mul, '/': operator.truediv, '%': operator.mod}
MAX_DEPTH = 48
MAX_STEPS = 400000


@dataclass
class Entry:
    key: str
    value: str
    conditional: bool
    # Each enclosing if block, outermost first: (the tests of its earlier branches, its own test or None for else).
    conditions: tuple = ()
    part: str | None = None
    # An id per enclosing block branch, outermost first: lines of one branch run under one test, taken when the first of them runs.
    blocks: tuple = ()


@dataclass
class Section:
    name: str
    entries: list[Entry] = field(default_factory=list)
    # The comment line right above the header, else the first one before its first line: a key's display name.
    comment: str | None = None

    def get(self, key):
        return next((e.value for e in self.entries if e.key == key), None)


@dataclass
class Buffer:
    type: str
    format: str
    stride: int
    filename: str


@dataclass
class Draw:
    # None for `INDEX_COUNT, FIRST_INDEX`: the original geometry passed through.
    count: int | None
    first: int | None
    entry: Entry


@dataclass
class Override:
    """A [TextureOverride*] section with a hash, with every line of the command lists it reaches after its own."""
    section: str
    hash: str
    component: int | None
    # match_index_count: the importer tells the level by it, since exporters name LOD sections inconsistently.
    index_count: int | None
    keys: dict
    lines: list[Entry]
    draws: list[Draw]


@dataclass
class SlotTexture:
    component: int | None
    slot: str
    filename: str
    entry: Entry


@dataclass
class Stream:
    """A vertex buffer bound at a component's draw, as the slot sees it."""
    slot: str
    # The bound resource or pool section as the ini names it.
    resource: str
    file: str | None
    stride: int
    format: str
    # (semantic with its index, format, byte offset) per element; empty when no source tells the layout.
    layout: list
    # A buffer a shader writes (RW type or unordered access); base_file is the file buffer copied into it.
    rw: bool = False
    base_file: str | None = None


@dataclass
class Segment:
    """A draw call of a component at the evaluated values; count and first are None for the original geometry passed through."""
    first: int | None
    count: int | None
    # (earlier tests, test) of the blocks around the call, its callers' included, that test a key's variable or a slot format.
    condition: tuple
    # Slot -> its candidate (file or None for unbound, the untaken tests it depends on) bindings; untouched slots keep the game's.
    # `hash:<h>` is the file a texture override puts in place of the original texture of hash h wherever the game binds it.
    textures: dict
    # The custom shader replacing a shader stage the call is drawn with, an effect redraw rather than geometry.
    custom_shader: str | None = None
    # The (slot, setting id, value) of each switch value binding another file at this call than at others of its textures: a
    # key that draws it in a group of its own (mod_settings.Plan.split).
    split: tuple = ()


@dataclass
class Component:
    id: int
    section: str
    hash: str
    index_count: int | None
    # Streams bound at the first geometry draw (at the end when nothing draws).
    streams: list[Stream]
    ib: dict | None
    segments: list[Segment]
    # (vertex group offset, count) in the merged skeleton.
    merged_pool: tuple | None
    # Shape key id -> its value at the evaluated values.
    shape_keys: dict
    custom_shader_kind: str | None
    # (section, kind, run at the evaluated values) of each custom shader the component's lines name.
    custom_shaders: list
    # The RW buffers a reached line binds as a vertex stream, the custom shaders writing them, and whether one is bound at the draw.
    deform: dict | None


@dataclass
class EfmiMod:
    root: Path
    ini: Path
    # Every ini that is read, in include_recursive order (files, then subfolders, by name), `ini` the first.
    inis: list[Path]
    sections: list[Section]
    name: str | None
    buffers: dict[str, Buffer]
    entry_points: dict[int, str]
    draws: dict[int, list[tuple[int, int]]]
    # (texture hash, filename) of each `this = <resource>` override.
    textures: list[tuple[str, str]]
    # Every filename the inis name, with '/' separators -> its checked path.
    files: dict[str, Path]
    merged_skeleton: bool
    overrides: list[Override] = field(default_factory=list)
    slot_textures: list[SlotTexture] = field(default_factory=list)
    # (`Resource\<namespace>\<name>`, filename): a texture handed to another mod.
    external_textures: list[tuple[str, str]] = field(default_factory=list)
    constants: dict[str, str] = field(default_factory=dict)
    keys: list[dict] = field(default_factory=list)
    # Merged-skeleton component id -> (vertex group offset, count).
    skeleton: dict[int, tuple[int, int]] = field(default_factory=dict)
    bones_count: int | None = None
    # Meshes/Components.buf: buffer name -> its semantics.
    layouts: dict = field(default_factory=dict)
    # Each variable after [Constants], the EFMI registration and one [Present] ran, as numbers.
    defaults: dict = field(default_factory=dict)
    components: dict[int, Component] = field(default_factory=dict)
    # CustomShader section -> geometry, pixel_effect, 2d_panel, compute or state.
    custom_shaders: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    # Filename -> 'srgb' or 'linear' of a Resource's color_space, which the runtime loads the DDS by in place of its own format.
    color_spaces: dict = field(default_factory=dict)
    # Ini file name -> the ps-t registers its ShaderRegex sections name, for each ini that patches the game's shaders.
    shader_patches: dict = field(default_factory=dict)
    # Ini file name -> (register, channel, threshold) of each patch `cutout` reads as a mask that drops pixels.
    cutouts: dict = field(default_factory=dict)


def parse_ini(text):
    """Sections in file order; keys are lower-cased and each line keeps the if/elif/else blocks around it."""
    sections, current, stack, part, blocks, note = [], None, [], None, [], None
    for raw in text.splitlines():
        # 3DMigoto reads a `;` as a comment only at the start of a line; elsewhere it is part of the value.
        line, comment = raw.strip(), ''
        if line.startswith(';'):line, comment = '', line[1:]
        if match := PART.search(comment):part = match.group(1).strip()
        if not line:
            note = comment.strip(' \t-=#*') or None if raw.strip() else None
            if note and current is not None and not current.entries and current.comment is None:current.comment = note
            continue
        if line.startswith('['):
            # The section name runs up to the first `]`, or to the end of the line without one.
            current = Section(line[1:].partition(']')[0].strip(), comment=note); sections.append(current); stack, part, blocks, note = [], None, [], None
            continue
        note = None
        word = line.split(None, 1)[0].lower()
        if word in CONTROL:
            test = line[len(word):].strip()
            # 3DMigoto reads `else if` as `elif`.
            if word == 'else' and re.match(r'if\b', test, re.IGNORECASE):word, test = 'elif', test[2:].strip()
            if word == 'if':stack.append(((), test)); blocks.append(None)
            elif stack and word == 'endif':stack.pop(); blocks.pop()
            elif stack:stack[-1] = (stack[-1][0]+(stack[-1][1],), test if word == 'elif' else None)
            # A branch is told by the entry index it starts at and its depth, unique within the section.
            if stack and word != 'endif':blocks[-1] = (len(current.entries) if current else 0, len(stack), len(stack[-1][0]))
            continue
        if current is None:continue
        key, _, value = line.partition('=')
        key = key.strip().lower()
        current.entries.append(Entry(key, value.strip(), bool(stack), tuple(stack), part if key.startswith('drawindexed') else None, tuple(blocks)))
        if key.startswith('drawindexed'):part = None
    return sections


def evaluate(test, values):
    """True or False for `$var == constant` with a known `$var`; None for any other test, which is kept unevaluated."""
    match = re.fullmatch(r'(\$\S+)\s*==\s*(\S+)', test.strip())
    if not match or match.group(1).lower() not in values:return None
    a, b = values[match.group(1).lower()], match.group(2)
    try:return float(a) == float(b)
    except ValueError:return a.lower() == b.lower()


def active(entry, values):
    """Whether `entry` runs with every variable at `values`; an unknown test counts as true, so its later branches do not run."""
    return all(all(evaluate(t, values) is False for t in earlier) and (test is None or evaluate(test, values) is not False)
               for earlier, test in entry.conditions)


def checked_path(root, filename):
    """`filename` under `root`, found case-insensitively, refused unless it stays inside `root` with no symlink on the way."""
    step = root
    for part in Path(filename).parts:
        # By listing, not exists(): a case-insensitive volume would accept the ini's spelling and keep it.
        if part not in ('.', '..') and step.is_dir() and not step.is_symlink() and part not in (names := {p.name for p in step.iterdir()}):
            match = [n for n in names if n.casefold() == part.casefold()]
            if len(match) == 1:part = match[0]
        step = step/part
        if step.is_symlink():raise ValueError('unsafe_path')
    resolved = step.resolve()
    if not resolved.is_relative_to(root):raise ValueError('unsafe_path')
    return resolved


def component(pattern, name):
    match = re.fullmatch(pattern, name, re.IGNORECASE)
    return int(match.group(1)) if match else None


def target(value):
    """The section a `ref <name>` or bare `<name>` value names, lower-cased."""
    value = value.strip()
    return (value[4:] if value.lower().startswith('ref ') else value).strip().lower()


def reach(entries, by_name, seen):
    """`entries` with the lines of each command list they run or ref spliced in after the line, under that line's blocks."""
    out = []
    for e in entries:
        out.append(e)
        name = target(e.value)
        if (e.key in ('run', 'pre run', 'post run') or e.value.lower().startswith('ref ')) and name.startswith('commandlist') and \
                name in by_name and name not in seen:
            seen.add(name)
            out += [Entry(c.key, c.value, e.conditional or c.conditional, e.conditions+c.conditions, c.part, e.blocks+c.blocks)
                    for c in reach(by_name[name].entries, by_name, seen)]
    return out


def is_draw(key, value):
    """Whether a line is a draw call: an indexed one, or `draw = from_caller`, which redraws the caller's draw as it came."""
    return key in ('drawindexed', 'drawindexedinstanced') or (key == 'draw' and value.strip().lower() == 'from_caller')


def draw_call(entry):
    """drawindexed = count, first, base; drawindexedinstanced = count, INSTANCE_COUNT, first, base, FIRST_INSTANCE."""
    if entry.key == 'draw':return Draw(None, None, entry)
    values = [v.strip() for v in entry.value.split(',')]
    count, first = (values[0], values[1]) if entry.key == 'drawindexed' else (values[0], values[2])
    if count.isdigit() and first.isdigit():return Draw(int(count), int(first), entry)
    return Draw(None, None, entry)


def excluded(name):
    """Whether EFMI's include_recursive skips a file or folder of this name: DISABLED* and desktop.ini."""
    return name.casefold().startswith('disabled') or name.casefold() == 'desktop.ini'


def loaded_ini(name):
    # 3DMigoto compares the extension case-sensitively.
    return name.endswith('.ini') and not excluded(name)


def ini_files(root, folder=''):
    """The inis 3DMigoto loads under `folder` of `root`: its files, then each subfolder's, both in case-insensitive name order."""
    entries = sorted((p for p in (checked_path(root, folder) if folder else root).iterdir() if not excluded(p.name)),
                     key=lambda p: p.name.casefold())
    files = [checked_path(root, f'{folder}/{p.name}' if folder else p.name) for p in entries if loaded_ini(p.name) and p.is_file()]
    return files+[f for p in entries if p.is_dir() for f in ini_files(root, f'{folder}/{p.name}' if folder else p.name)]


def hex_value(text):
    """The number 3DMigoto reads from a whole hash value (`%16llx`: up to 16 characters, 0x prefix allowed), or None."""
    text = (text or '').strip()
    return int(text, 16) if len(text) <= 16 and HEX.fullmatch(text) else None


def filter_keys(sections):
    """[Filter*] section with a match_dhash -> the slot key `filter:<dhash>:<match_format>:<max Hamming distance>` it binds under."""
    out = {}
    for s in sections:
        if not s.name.lower().startswith('filter') or (dhash := hex_value(s.get('match_dhash'))) is None:continue
        try:confidence = min(max(float(s.get('match_confidence') or 0.75), 0.0), 1.0)
        except ValueError:confidence = 0.75
        out[s.name.lower()] = f'filter:{dhash:016x}:{plain_format(s.get("match_format") or "")}:{int((1-confidence)*64)}'
    return out


def slot_key(key, filters):
    """The slot a `ps-tN` or `ps-t[<filter>]` key binds, or None for any other key."""
    if SLOT.fullmatch(key):return key
    match = FILTER_SLOT.fullmatch(key)
    return filters.get(match.group(1)) if match else None


def priority(text):
    """A section's match_priority, 0 when it has none."""
    text = (text or '').strip()
    return int(text) if re.fullmatch(r'[-+]?\d+', text) else 0


def bem_package(root):
    """Whether a file under `root` starts with the BEM package magic."""
    for d, _, names in os.walk(root):
        for n in names:
            path = Path(d)/n
            if path.is_file() and not path.is_symlink():
                with path.open('rb') as f:
                    if f.read(len(BEM_MAGIC)) == BEM_MAGIC:return True
    return False


def phase_key(key):
    """`key` without its `pre `/`post ` prefix."""
    word, _, rest = key.partition(' ')
    return rest.strip() if word in ('pre', 'post') and rest.strip() else key


def resource_name(value):
    """The resource, pool slot or shader slot a binding value names, lower-cased, without ref, reference or copy."""
    words = value.strip().split(None, 1)
    if len(words) == 2 and words[0].lower() in ('ref', 'reference', 'copy'):value = words[1]
    return value.strip().lower()


def plain_format(name):
    name = name.strip().upper()
    return name[len('DXGI_FORMAT_'):] if name.startswith('DXGI_FORMAT_') else name


def stride_layout(slot, stride):
    """The stride family's (semantic, format, offset) elements of a vertex buffer in `slot`; vb3 carries positions like vb0."""
    return list(STRIDE_LAYOUTS.get(('vb0' if slot == 'vb3' else slot, stride), []))


def truth(value):
    return None if value is None else value != 0


@functools.lru_cache(maxsize=None)
def tokens(text):
    """The (group, text) tokens of an ini expression, or None when part of it is no expression."""
    out, i, text = [], 0, text.strip()
    while i < len(text):
        match = TOKEN.match(text, i)
        if not match or match.end() == i:return None
        out.append((match.lastindex, match.group(match.lastindex))); i = match.end()
    return tuple(out)


def apply(op, a, b):
    if op in ('||', '&&'):
        ta, tb = truth(a), truth(b)
        if op == '||':return 1.0 if True in (ta, tb) else None if None in (ta, tb) else 0.0
        return 0.0 if False in (ta, tb) else None if None in (ta, tb) else 1.0
    if a is None or b is None or (op in ('/', '%') and b == 0):return None
    return float(OPERATORS[op](a, b))


def calculate(text, lookup):
    """(value, unsure) of an ini expression; value is None where it needs what only the game knows (its draw, shaders, time),
    and unsure tells that a slot's format was among those unknowns."""
    found = tokens(text)
    if not found:return None, False
    state = dict(pos=0, unsure=False)
    def atom():
        group, word = found[state['pos']]; state['pos'] += 1
        if group == 4 and word == '(':
            value = level(0)
            if found[state['pos']] != (4, ')'):raise ValueError
            state['pos'] += 1
            return value
        if group == 4 and word in '!-+':
            value = atom()
            return None if value is None else float(value == 0) if word == '!' else -value if word == '-' else value
        if group == 4:raise ValueError
        if group == 1:return float(word)
        if group == 2:
            value = lookup(word.lower()+'->format')
            if value is None:state['unsure'] = True
            return value
        # A pool element or another of the game's values (vb0, DRAW_TYPE, ps->cb_size(6), time) is unknown.
        return lookup(word.lower()) if group == 3 and '[' not in word else None
    def level(n):
        if n == len(BINARY):return atom()
        left = level(n+1)
        while state['pos'] < len(found) and found[state['pos']][0] == 4 and found[state['pos']][1] in BINARY[n]:
            op = found[state['pos']][1]; state['pos'] += 1
            left = apply(op, left, level(n+1))
        return left
    try:
        value = level(0)
        if state['pos'] != len(found):return None, False
    except (ValueError, IndexError):return None, False
    return value, state['unsure']


class Overrun(Exception):
    pass


# A slot or saved resource that holds the game's own texture.
ORIGINAL = object()


class Scene:
    """What the evaluation reads of a loaded mod: sections by name, custom shader kinds, the RW buffers' writers, DDS formats."""

    def __init__(self, mod):
        self.mod = mod
        self.by_name = {s.name.lower(): s for s in mod.sections}
        self.key_vars = {v for k in mod.keys for v in k['values']}
        geometry = {resource_name(e.value).split('[')[0] for s in mod.sections for e in s.entries if STREAM.fullmatch(phase_key(e.key))}
        self.kinds = {s.name.lower(): shader_kind(s, geometry) for s in mod.sections if s.name.lower().startswith('customshader')}
        # RW resource -> the custom shaders writing it; custom shader -> what it reads as cs-t0, the positions it starts from.
        self.writers, self.inputs = {}, {}
        for s in mod.sections:
            if s.name.lower() in self.kinds:
                for e in s.entries:
                    if re.fullmatch(r'cs-u\d+', e.key) and (name := resource_name(e.value)) != 'null':
                        self.writers.setdefault(name.split('[')[0], []).append(s.name.lower())
                    if e.key == 'cs-t0' and (name := resource_name(e.value)) != 'null':self.inputs.setdefault(s.name.lower(), name.split('[')[0])
        self.copies, self.formats = {}, {}
        self.filters = filter_keys(mod.sections)
        # The overrides a texture check runs, those that reach a `this` line, in the runtime's (match_priority, section name) order.
        self.checked = sorted((o for o in mod.overrides if any(phase_key(e.key) == 'this' for e in o.lines)),
                              key=lambda o: (priority(self.by_name[o.section.lower()].get('match_priority')), o.section))

    def file(self, name):
        section = self.by_name.get(name.split('[')[0]) if name else None
        filename = section.get('filename') if section else None
        return filename.replace('\\', '/') if filename else None

    def rw(self, name):
        section = self.by_name.get(name)
        return bool(section) and ('rw' in (section.get('type') or '').lower() or 'unordered_access' in (section.get('bind_flags') or '').lower())

    def dxgi(self, filename):
        """The DXGI format code of a mod DDS, or None."""
        if filename not in self.formats:
            self.formats[filename] = None
            path = self.mod.files.get(filename)
            if path and filename.lower().endswith('.dds'):
                with path.open('rb') as f:head = f.read(148)
                if len(head) >= 128 and head[:4] == b'DDS ':
                    fourcc = head[84:88]
                    if fourcc == b'DX10' and len(head) == 148:self.formats[filename] = float(struct.unpack_from('<I', head, 128)[0])
                    elif fourcc in FOURCC_DXGI:self.formats[filename] = float(FOURCC_DXGI[fourcc])
                    elif struct.unpack_from('<5I', head, 88) == RGBA_MASKS:self.formats[filename] = 28.0
            # A Resource's color_space loads the file as the sRGB or UNORM variant of its format (BC7 98/99, BC3 77/78, RGBA8 28/29).
            space = self.mod.color_spaces.get(filename)
            pairs = {98.0: 99.0, 77.0: 78.0, 28.0: 29.0}
            if space == 'srgb':self.formats[filename] = pairs.get(self.formats[filename], self.formats[filename])
            elif space == 'linear':self.formats[filename] = {v: k for k, v in pairs.items()}.get(self.formats[filename], self.formats[filename])
        return self.formats[filename]

    def marks(self, condition):
        """Whether a (earlier tests, test) block tests a key's variable or a slot format."""
        texts = [t.lower() for t in (*condition[0], condition[1]) if t]
        return any('->format' in t or self.key_vars & set(re.findall(r'\$[\\\w.]+', t)) for t in texts)

    def layout(self, slot, section, file, stride):
        names = []
        if section:
            lower = section.name.lower()
            names.append(section.name[len('resource_') if lower.startswith('resource_') else len('resource') if lower.startswith('resource') else 0:])
        if file:names.append(Path(file).stem)
        for name in names:
            if (found := json_layout(self.mod.layouts.get(name))) is not None:return found
        return stride_layout(slot, stride)

    def origin(self, name, cid, depth=0):
        """The file buffer section an RW buffer starts from: the one copied into its pool slot, or what its writer reads as cs-t0."""
        source = self.copies.get((name, cid)) or next((self.inputs[w] for w in self.writers.get(name, ()) if w in self.inputs), None)
        if source is None or depth > 8:return None
        return source if self.file(source) and not self.rw(source) else self.origin(source, cid, depth+1)

    def stream(self, slot, name, formats, cid):
        base = name.split('[')[0]
        section = self.by_name.get(base)
        rw = self.rw(base)
        source = self.origin(base, cid) if rw else None
        base_file = self.file(source) if source else None
        stride = next((int(s.get('stride')) for s in (section, self.by_name.get(source or '')) if s and (s.get('stride') or '').isdigit()), 0)
        layout = self.layout(slot, self.by_name.get(source) if source else section, base_file or self.file(base), stride)
        layout = [(semantic, formats.get((slot, semantic), fmt), offset) for semantic, fmt, offset in layout]
        return Stream(slot, section.name if section else name, self.file(base), stride, plain_format(section.get('format') or '') if section else '',
                      layout, rw, base_file)

    def index_buffer(self, name):
        if not name:return None
        section = self.by_name.get(name.split('[')[0])
        stride = int(section.get('stride')) if section and (section.get('stride') or '').isdigit() else 0
        fmt = plain_format(section.get('format') or '') if section else ''
        return dict(file=self.file(name), format=fmt or {2: 'R16_UINT', 4: 'R32_UINT'}.get(stride, ''))

    def shape_keys(self, start):
        """Component id -> shape key id -> value of each call of the command list that runs EFMI's shape key setter."""
        setters = {n for n, s in self.by_name.items() if any(phase_key(e.key) == 'run' and target(e.value) == SHAPEKEY_SETTER for e in s.entries)}
        found = {}
        for s in self.mod.sections:
            local = {}
            def lookup(name):return local[name] if name in local else start.get(name)
            for e in s.entries:
                key = phase_key(e.key)
                if key in ('$component_id', '$shapekey_id', '$shapekey_value'):local[key] = calculate(e.value, lookup)[0]
                elif key == 'run' and target(e.value) in setters:
                    cid, sid, value = (lookup(n) for n in ('$component_id', '$shapekey_id', '$shapekey_value'))
                    if cid is not None and sid is not None:found.setdefault(int(cid), {})[int(sid)] = value
        return found

    def component(self, override, run, shape_keys):
        bound, formats = run.drawn or (run.bound, run.element_formats)
        cid = override.component
        streams = [self.stream(slot, name, formats, cid) for slot, name in sorted(bound.items()) if slot != 'ib' and name and name != 'null']
        named = [target(e.value) for e in override.lines if phase_key(e.key) == 'run' and target(e.value) in self.kinds]
        shaders = list(dict.fromkeys(named+run.ran))
        kinds = {self.kinds[n] for n in run.ran}
        rw = list(dict.fromkeys(n for e in override.lines if STREAM.fullmatch(phase_key(e.key)) and phase_key(e.key) != 'ib'
                                and self.rw(n := resource_name(e.value).split('[')[0])))
        deform = dict(resources=[self.by_name[n].name for n in rw], writers=sorted({self.by_name[w].name for n in rw for w in self.writers.get(n, ())}),
                      active=any(s.rw for s in streams)) if rw else None
        return Component(cid, override.section, override.hash, override.index_count, streams, self.index_buffer(bound.get('ib')),
                         run.segments, self.mod.skeleton.get(cid), shape_keys.get(cid, {}), next((k for k in KINDS if k in kinds), None),
                         [(self.by_name[n].name, self.kinds[n], n in run.ran) for n in shaders], deform)


def json_layout(entry):
    """(semantic, format, offset) elements of a Components.buf entry, or None when it is not one."""
    if not isinstance(entry, dict) or not isinstance(entry.get('semantics'), list):return None
    out, offset = [], 0
    for s in entry['semantics']:
        if not isinstance(s, dict) or not isinstance(s.get('stride'), int) or not isinstance(s.get('name'), str) or not isinstance(s.get('format'), str):
            return None
        out.append((s['name'].upper()+str(s.get('index', 0)), plain_format(s['format']), offset)); offset += s['stride']
    return out


def shader_kind(section, geometry):
    """geometry when a compute shader writes a buffer drawn as a stream, or a vertex/geometry stage is replaced; 2d_panel for a
    non-indexed draw; pixel_effect for a pixel shader alone; compute for another compute shader; state for render state only."""
    def stage(key):return (section.get(key) or '').strip().lower() not in ('', 'null')
    if stage('cs'):
        writes = {resource_name(e.value) for e in section.entries if re.fullmatch(r'cs-u\d+', e.key)}
        return 'geometry' if writes & geometry else 'compute'
    if section.get('draw') is not None and not any(e.key.startswith('drawindexed') for e in section.entries):return '2d_panel'
    if any(stage(k) for k in ('vs', 'gs', 'hs', 'ds')):return 'geometry'
    return 'pixel_effect' if stage('ps') else 'state'


class Run:
    """One pass over the mod's command lists as data: variables, bindings and draw calls; no shader or file of the mod runs."""

    def __init__(self, scene, values, slot_formats=None, override=None):
        """`override` is the component override whose pass this is: a texture check tests the match_* keys against its draw."""
        self.scene, self.values, self.slot_formats, self.override = scene, dict(values), slot_formats, override
        self.lists, self.bound, self.slots, self.saved, self.element_formats = {}, {}, {}, {}, {}
        self.segments, self.ran, self.shader, self.drawn, self.steps = [], [], [], None, 0
        # `hash:<h>` -> candidates of the `this` of texture hash h a texture check decided; `this` is the hash being checked.
        self.hashes, self.this = {}, None

    def lookup(self, name):
        if not name.endswith('->format'):return self.values.get(name)
        bound = self.slots.get(name[:-len('->format')])
        if bound and len(bound) == 1 and not bound[0][1]:
            # A slot holding one of the mod's textures has that texture's format; an unbound one is -2 (RESOURCE_NOT_FOUND).
            return -2.0 if bound[0][0] is None else self.scene.dxgi(bound[0][0])
        if self.slot_formats is None:return None
        return float(self.slot_formats[name[:-len('->format')]]) if name[:-len('->format')] in self.slot_formats else -2.0

    def test(self, text):
        value, unsure = calculate(text, self.lookup)
        return truth(value), unsure

    def branch(self, earlier, test):
        """The open slot-format tests a branch is taken under, or None when it is not taken; any other unknown test is taken."""
        fork = ()
        for t in earlier:
            value, unsure = self.test(t)
            if value or (value is None and not unsure):return None
            if value is None:fork += ('!('+t+')',)
        if test is None:return fork
        value, unsure = self.test(test)
        if value is False:return None
        return fork+((test,) if value is None and unsure else ())

    def section(self, entries, outer, fork, depth):
        """The lines of one section: `pre` and unprefixed ones, then `post` ones; a branch's test is taken at its first line."""
        taken = {}
        for phase in ('pre', 'post'):
            for e in entries:
                key = phase_key(e.key)
                if (e.key.startswith('post ') and key != e.key) != (phase == 'post'):continue
                own = ()
                for (earlier, test), block in zip(e.conditions, e.blocks):
                    if block not in taken:taken[block] = self.branch(earlier, test)
                    if taken[block] is None:break
                    own += taken[block]
                else:
                    self.line(key, e.value, outer+e.conditions, fork+own, depth)

    def line(self, key, value, conditions, fork, depth):
        self.steps += 1
        if self.steps > MAX_STEPS:raise Overrun
        words = key.split()
        if key == 'run':self.call(target(value), conditions, fork, depth)
        elif is_draw(key, value):self.draw(key, value, conditions)
        elif STREAM.fullmatch(key):self.bound[key] = self.buffer(value)
        elif slot := slot_key(key, self.scene.filters):self.bind(slot, value, fork, self.slots)
        elif key == 'this':
            # Outside a texture check `this` sets nothing.
            if self.this is not None:self.bind('hash:'+self.this, value, fork, self.hashes)
        elif key == 'checktextureoverride' and SLOT.fullmatch(resource_name(value)):self.check(conditions, fork, depth)
        elif match := ELEMENT_FORMAT.fullmatch(key):self.element_formats[match.group(1), match.group(2).upper()+match.group(3)] = plain_format(value)
        elif words and words[-1].startswith('$') and set(words[:-1]) <= {'global', 'local', 'persist'}:
            if '[' in words[-1]:return
            number = calculate(value, self.lookup)[0] if value else 0.0
            if number is None:self.values.pop(words[-1], None)
            else:self.values[words[-1]] = number
        elif key.startswith('commandlist'):self.lists[key] = None if value.strip().lower() == 'null' else target(value)
        elif key.startswith('resource'):
            name = resource_name(value)
            self.saved[key] = self.slots.get(name, ORIGINAL) if SLOT.fullmatch(name) else self.saved.get(name, name)
        elif '[' in key and value.strip().lower().startswith('copy ') and self.values.get('$component_id') is not None:
            self.scene.copies[key.split('[')[0], int(self.values['$component_id'])] = resource_name(value)

    def call(self, name, conditions, fork, depth):
        for _ in range(8):
            if name not in self.lists:break
            name = self.lists[name]
            if name is None:return
        if name == OVERRIDE_TEXTURES:return self.check(conditions, fork, depth)
        # Variants such as Component_DrawInstances_NoDecomposition call back alike.
        for callback in next((v for k, v in CALLBACKS.items() if name.startswith(k)), ()):
            if not self.lists.get(callback):continue
            kept = dict(self.slots), dict(self.hashes)
            self.call(self.lists[callback], conditions, fork, depth)
            # Component_Instance_DrawCustom restores every slot after the custom draw; NoDecomposition calls it bare.
            if callback == DRAW_CUSTOM and not name.endswith('_nodecomposition'):self.slots, self.hashes = kept
        section = self.scene.by_name.get(name)
        if section is None or depth >= MAX_DEPTH:return
        kind = self.scene.kinds.get(name)
        if kind is not None:self.ran.append(name)
        if kind not in (None, 'state'):self.shader.append(section.name)
        try:self.section(section.entries, conditions, fork, depth+1)
        finally:
            if kind not in (None, 'state'):self.shader.pop()

    def buffer(self, value):
        name = resource_name(value)
        for _ in range(8):
            if not isinstance(self.saved.get(name), str):break
            name = self.saved[name]
        return name

    def check(self, conditions, fork, depth):
        """A texture check: each texture override that accepts the draw runs, its `this` replacing the texture of its hash."""
        if depth >= MAX_DEPTH:return
        outer = self.this
        try:
            for o in self.scene.checked:
                if not self.matches(o):continue
                self.this = o.hash
                self.section(self.scene.by_name[o.section.lower()].entries, conditions, fork, depth+1)
        finally:self.this = outer

    def matches(self, o):
        """Whether `o`'s match_index_count and match_first_index accept the draw of this pass; a value not known on either side does."""
        for key in ('match_index_count', 'match_first_index'):
            own, drawn = o.keys.get(key, '').strip(), (self.override.keys.get(key, '') if self.override else '').strip()
            if own.isdigit() and drawn.isdigit() and int(own) != int(drawn):return False
        return True

    def bind(self, slot, value, fork, into):
        name = resource_name(value)
        state = self.slots.get(name, ORIGINAL) if SLOT.fullmatch(name) else self.saved.get(name, name)
        if isinstance(state, str):state = ((None if state == 'null' else self.scene.file(state), ()),)
        if not fork:
            if state is ORIGINAL:into.pop(slot, None)
            else:into[slot] = state
            return
        # Under an open slot-format test the binding is one candidate more; the others stay for when the test fails.
        kept = tuple(c for c in into.get(slot, ()) if c[1] != fork)
        added = () if state is ORIGINAL else tuple((f, fork+t) for f, t in state)
        if kept+added:into[slot] = kept+added
        else:into.pop(slot, None)

    def draw(self, key, value, conditions):
        args = [a.strip() for a in value.split(',')]+['', '']
        count, first = (None, None) if key == 'draw' else \
            (calculate(a, self.lookup)[0] if a else None for a in (args[0], args[1 if key == 'drawindexed' else 2]))
        shader = self.shader[-1] if self.shader else None
        textures = dict(self.slots, **self.hashes)
        self.segments.append(Segment(None if first is None else int(first), None if count is None else int(count),
                                     tuple(c for c in conditions if self.scene.marks(c)), textures, shader))
        if shader is None and self.drawn is None:self.drawn = (dict(self.bound), dict(self.element_formats))


def startup(scene, values=None):
    """The variables of a frame in which the mod draws: [Constants], then `values` over them, the EFMI registration command lists
    and [Present], then [Present] again with $object_detected = 1, which derives the toggles' $draw_* from their swap vars."""
    run = Run(scene, {})
    sections = scene.mod.sections
    present = [s for s in sections if s.name.lower() == 'present']
    def each(found):
        try:
            for s in found:run.section(s.entries, (), (), 0)
        except Overrun:pass
    each([s for s in sections if s.name.lower() == 'constants'])
    run.values.update({k.lower(): float(v) for k, v in (values or {}).items()})
    each([s for s in sections if any(phase_key(e.key) == 'run' and target(e.value) == REGISTER for e in s.entries)]+present)
    run.values['$object_detected'] = 1.0
    each(present)
    return run.values


def components(mod, values=None, slot_formats=None):
    """Component id -> Component of each component's override with the largest match_index_count, evaluated at the defaults with
    `values` (variable -> number) over them; `slot_formats` (ps-tN -> DXGI code, others unbound) decides the game's slot formats."""
    scene = Scene(mod)
    start = startup(scene, values)
    chosen = {}
    for o in mod.overrides:
        if o.component is not None and (o.component not in chosen or (o.index_count or -1) > (chosen[o.component].index_count or -1)):
            chosen[o.component] = o
    shape_keys, out = scene.shape_keys(start), {}
    for cid, o in sorted(chosen.items()):
        run = Run(scene, start, slot_formats, o)
        try:run.section(scene.by_name[o.section.lower()].entries, (), (), 0)
        except Overrun:pass
        out[cid] = scene.component(o, run, shape_keys)
    return out


def load_mod(root):
    root = Path(root).resolve()
    if not any(loaded_ini(p.name) and p.is_file() for p in root.iterdir()):
        # A folder above the mod opens the shallowest folder holding an ini, when there is exactly one.
        found = []
        for d, folders, names in os.walk(root):
            folders[:] = [n for n in folders if not excluded(n)]
            if any(loaded_ini(n) for n in names):found.append((len(Path(d).relative_to(root).parts), Path(d)))
        found.sort()
        if len(found) > 1 and found[0][0] == found[1][0]:raise ValueError('ambiguous_ini')
        if found:return load_mod(found[0][1])
        if bem_package(root):raise ValueError('unsupported_mod:BEM 包（BEM\\0PKG\\0）不是 EFMI mod，这里只读 EFMI 的 .ini')
        raise ValueError('unsupported_mod:目录里没有 .ini，不是 EFMI mod')
    inis = ini_files(root)
    sections, owner, total = [], {}, 0
    for ini in inis:
        size = ini.stat().st_size; total += size
        if size > MAX_FILE_BYTES:raise ValueError('mod_too_large')
        own = parse_ini(ini.read_text(encoding='utf-8-sig'))
        # A resource's file is relative to the folder of the ini naming it.
        if (folder := ini.parent.relative_to(root).as_posix()) != '.':
            for e in (e for s in own for e in s.entries if e.key == 'filename'):e.value = folder+'/'+e.value
        # One section in two files would be two namespaces in 3DMigoto, which the lookups by name here cannot tell apart.
        for s in own:
            if owner.setdefault(s.name.lower(), ini) != ini:raise ValueError('ambiguous_ini')
        sections += own
    # EFF's [Mod] format= ini swaps Unity assets, not draw calls.
    if any(s.name.lower() == 'mod' and s.get('format') is not None for s in sections):raise ValueError(EFF)
    files = {}
    for s in sections:
        for e in s.entries:
            if e.key != 'filename' or e.value.replace('\\', '/') in files:continue
            name = e.value.replace('\\', '/')
            files[name] = checked_path(root, name)
            size = files[name].stat().st_size; total += size
            if size > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES:raise ValueError('mod_too_large')
            with files[name].open('rb') as f:
                if f.read(16) == b'EFF_AUTHOR_FILE3':raise ValueError(EFF)
    by_name = {s.name.lower(): s for s in sections}
    resources = {s.name.lower(): s.get('filename').replace('\\', '/') for s in sections if s.get('filename')}
    filters = filter_keys(sections)
    buffers, entry_points, draws, textures, name = {}, {}, {}, [], None
    constants, keys, skeleton, overrides, slots, external = {}, [], {}, [], [], []
    # Skeleton pool name -> offsets or counts, by the template's names and by what the mod binds to EFMI's inputs.
    pools = {TEMPLATE_POOL+'offsets': 'offsets', TEMPLATE_POOL+'counts': 'counts'}
    pools.update({target(e.value): e.key[len(POOL_INPUT):] for s in sections for e in s.entries if e.key in (POOL_INPUT+'offsets', POOL_INPUT+'counts')})
    for s in sections:
        lower = s.name.lower()
        if lower == 'resourcemodname':name = (s.get('data') or '').strip('"')
        elif lower.startswith('resource') and ((s.get('type') or '').lower() == 'buffer' or
                                               (s.get('filename') or '').lower().endswith(('.buf', '.ib', '.vb'))):
            buffers[s.name[len('resource_' if lower.startswith('resource_') else 'resource'):]] = Buffer(
                s.get('type') or '', s.get('format') or '', int(s.get('stride') or 0), (s.get('filename') or '').replace('\\', '/'))
        if lower == 'constants':
            for e in s.entries:
                words = e.key.split()
                if words and words[-1].startswith('$'):constants[words[-1]] = e.value
        if lower.startswith('key'):
            keys.append(dict(section=s.name, key=s.get('key'), type=s.get('type'), condition=s.get('condition'),
                             values={e.key: [v.strip() for v in e.value.split(',')] for e in s.entries if e.key.startswith('$')}))
        variables = {}
        for e in s.entries:
            if e.key.startswith('$') and e.value.isdigit():variables[e.key] = int(e.value)
            if (match := SKELETON.fullmatch(e.key)) and match.group(1) in pools and e.value.isdigit():
                index = match.group(2).strip()
                index = int(index) if index.isdigit() else variables.get(index)
                if index is not None:
                    offset, count = skeleton.get(index, (None, None))
                    skeleton[index] = (int(e.value), count) if pools[match.group(1)] == 'offsets' else (offset, int(e.value))
            if e.key.startswith('resource\\') and target(e.value) in resources and resources[target(e.value)].lower().endswith('.dds'):
                external.append((e.key, resources[target(e.value)]))
        # The runtime skips a texture override whose hash it cannot read.
        if not lower.startswith('textureoverride') or (number := hex_value(s.get('hash'))) is None:continue
        lines = reach(s.entries, by_name, {lower})
        own = {k: s.get(k) for k in ('hash', 'match_first_index', 'match_index_count', 'filter_index', 'handling', 'this') if s.get(k) is not None}
        cid = next((int(e.value) for e in s.entries+lines if e.key == '$\\efmiv1\\component_id' and e.value.isdigit()), None)
        if cid is None and (match := re.search(r'component(\d+)', lower)):cid = int(match.group(1))
        count = own.get('match_index_count')
        override = Override(s.name, '%08x' % (number & 0xffffffff), cid, int(count) if count and count.isdigit() else None, own, lines,
                            [draw_call(e) for e in lines if is_draw(e.key, e.value)])
        overrides.append(override)
        if cid is not None:
            entry_points.setdefault(cid, override.hash)
            draws.setdefault(cid, [(d.count, d.first) for d in override.draws])
        if own.get('this') and target(own['this']) in resources:textures.append((override.hash, resources[target(own['this'])]))
        slots += [SlotTexture(cid, slot, resources[target(e.value)], e) for e in lines
                  if (slot := slot_key(e.key, filters)) and target(e.value) in resources]
    layouts = {}
    if (root/'Meshes').is_dir() and (path := checked_path(root, 'Meshes/Components.buf')).is_file() and path.stat().st_size <= MAX_FILE_BYTES:
        try:layouts = json.loads(path.read_bytes())
        except ValueError:layouts = {}
    # EFMI's guide says there is no merged skeleton, but its template and exporter emit these pools and remap buffers.
    merged = any(s.name.lower().startswith('pool_mergedskeleton') or
                 (s.name.lower().startswith('resource_') and s.name.lower().endswith('_blendremap')) for s in sections) or \
        any(e.key.startswith(POOL_INPUT) for s in sections for e in s.entries)
    bones = constants.get('$bones_count')
    if bones is None and (given := next((e.value.lower() for s in sections for e in s.entries if e.key == '$\\efmiv1\\bones_count'), None)):
        bones = constants.get(given, given)
    color_spaces = {resources[s.name.lower()]: space for s in sections if s.name.lower().startswith('resource') and s.name.lower() in resources
                    and (space := (s.get('color_space') or '').strip().lower()) in ('srgb', 'linear')}
    patches, texts = {}, {}
    for s in sections:
        if s.name.lower().startswith('shaderregex'):
            patches.setdefault(owner[s.name.lower()].name, set()).update(
                int(n) for e in s.entries for n in re.findall(r'\bt(\d+)\b', e.key+' '+e.value))
            texts[owner[s.name.lower()].name] = texts.get(owner[s.name.lower()].name, '')+'\n'.join(e.key+' '+e.value for e in s.entries)+'\n'
    cutouts = {name: c for name, text in texts.items() if (c := cutout(text))}
    warnings = ['shader_patch_ignored:'+name for name in patches]
    mod = EfmiMod(root=root, ini=inis[0], inis=inis, sections=sections, name=name, buffers=buffers, entry_points=entry_points, draws=draws,
                  textures=textures, files=files, merged_skeleton=merged, overrides=overrides, slot_textures=slots,
                  external_textures=external, constants=constants, keys=keys, skeleton=skeleton,
                  bones_count=int(bones) if bones and bones.isdigit() else None, layouts=layouts if isinstance(layouts, dict) else {},
                  warnings=warnings, color_spaces=color_spaces, shader_patches=patches, cutouts=cutouts)
    scene = Scene(mod)
    mod.custom_shaders = {by_name[n].name: kind for n, kind in scene.kinds.items()}
    mod.defaults = startup(scene)
    mod.components = components(mod)
    return mod


def read_buffer(mod, name):
    """(bytes, stride, format, element count) of buffer `name` (its section name without `Resource_`)."""
    buffer = mod.buffers[name]
    raw = mod.files[buffer.filename].read_bytes()
    if buffer.stride <= 0 or len(raw) % buffer.stride:raise ValueError('buffer_size')
    return raw, buffer.stride, buffer.format, len(raw)//buffer.stride


def mip_size(rd_format_name, width, height):
    if rd_format_name.endswith('_BLOCK'):return ((width+3)//4)*((height+3)//4)*16
    return width*height*4


def cutout(text):
    """(register, channel, threshold) of a shader patch that drops a pixel where one channel of a texture it declares, read at the
    texel frac(v1.xy) falls in, is below a constant; None for any other patch. `text` is the patch's lines, lower case."""
    declared = re.search(r'dcl_resource_texture2d\s*\([^)]*\)\s*t(\d+)', text)
    if not declared or not re.search(r'\bfrc\s+\S+,\s*v1\.xy', text):return None
    load = re.search(r'ld_indexable\(texture2d\)\([^)]*\)\s*(\S+)\.([xyzw]),\s*\S+,\s*t'+declared.group(1)+r'\.xyzw', text)
    test = load and re.search(r'\blt\s+(\S+)\.x,\s*'+re.escape(load.group(1))+r'\.'+load.group(2)+r',\s*l\(([0-9.]+)\)', text)
    if not test or not re.search(r'\bdiscard_nz\s+'+re.escape(test.group(1))+r'\.x\b', text):return None
    return int(declared.group(1)), 'xyzw'.index(load.group(2)), float(test.group(2))


def read_dds(path, color_space=None):
    """A DDS as a TextureBlob whose mips index into the pixel data after the headers; `color_space` 'srgb' or 'linear' (a
    Resource's color_space) reads it as the sRGB or the UNORM variant of its format, where the format has one."""
    raw = Path(path).read_bytes()
    # File offsets: 'DDS ' magic, 124-byte header (fourCC at 84), then a 20-byte DX10 header from 128 when fourCC is DX10.
    if len(raw) < 128 or raw[:4] != b'DDS ':raise ValueError('unsupported_texture_format')
    height, width = struct.unpack_from('<2I', raw, 12)
    [mip_count] = struct.unpack_from('<I', raw, 28)
    fourcc = raw[84:88]
    if fourcc == b'DX10':
        if len(raw) < 148:raise ValueError('unsupported_texture_format')
        [dxgi] = struct.unpack_from('<I', raw, 128)
        if dxgi not in DXGI_FORMATS:raise ValueError('unsupported_texture_format')
        fmt, data = DXGI_FORMATS[dxgi], raw[148:]
    elif fourcc in FOURCC_FORMATS:fmt, data = FOURCC_FORMATS[fourcc], raw[128:]
    elif fourcc == b'\0\0\0\0' and struct.unpack_from('<I', raw, 80)[0] & 0x40 and struct.unpack_from('<5I', raw, 88) == RGBA_MASKS:
        fmt, data = 'R8G8B8A8_UNORM', raw[128:]
    else:raise ValueError('unsupported_texture_format')
    if color_space == 'srgb':fmt = fmt.replace('_UNORM', '_SRGB') if fmt != 'BC5_UNORM_BLOCK' else fmt
    elif color_space == 'linear':fmt = fmt.replace('_SRGB', '_UNORM')
    mips, offset = [], 0
    for level in range(max(1, mip_count)):
        w, h = max(1, width >> level), max(1, height >> level)
        size = mip_size(fmt, w, h)
        mips.append(dict(level=level, width=w, height=h, offset=offset, size=size)); offset += size
    if offset != len(data):raise ValueError('texture_size')
    return TextureBlob(data, width, height, fmt, mips)
