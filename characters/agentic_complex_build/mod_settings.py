"""Read an EFMI mod's switches as data for the importer's endfield-mod-settings/v1 table: which segments of the imported
appearance each value of a switch draws, and which textures it binds instead.

A switch is a [Key*] section; its values are the states repeated presses of its key reach, value 0 the defaults. Each switch is
evaluated alone, the others at their defaults, as efmi_mod evaluates the command lists; none of the mod's shaders or scripts
runs. A switch named like underwear is not listed: it stays at the value whose draws hold the most indices.
Standard library only: this module ships in the app's content.
"""
import copy
from dataclasses import dataclass, field
from pathlib import PurePosixPath
import re

from . import efmi_geometry, efmi_mod, mesh_codec, texture_mips

SCHEMA = 'endfield-mod-settings/v1'
FILE = 'mod-settings.json'
MAX_SETTINGS = 64
MAX_VALUES = 16
MAX_SEGMENTS = 256
# A block draws its hidden segments' gaps, one run more than them, and the renderer draws at most 16 runs a block.
MAX_RUNS = 15
MAX_VARIANTS = 64
MAX_VARIANT_BYTES = 192*2**20
LABEL_BYTES = 64
ADULT_PARTS = ('panties', 'pantsu', 'underwear', 'lingerie', 'naked', 'nipple', '内衣', '内裤', '胸罩', '裸')
# Matched as whole words, so that `bra` is not `library` and `pants` not `participants`.
ADULT_WORDS = {'bra', 'bras', 'pants', 'nude'}
WORD = re.compile(r'[A-Z]?[a-z]+|[A-Z]+(?![a-z])')
VARIABLE = re.compile(r'\$[\\\w.]+')
# The condition of a segment the defaults do not draw, in place of its blocks' tests, so that it forms groups of its own.
MARK = 'mod_settings'
# A switch's category by the words of its name, panel icon and variables, lower-cased substrings, the first category matching.
CATEGORY_WORDS = (('accessory', ('耳坠', '耳环', '头箍', '发箍', '角', '尾巴', '挎包', '包', '武器', '眼镜', '项链',
                                 'earring', 'horn', 'tail', 'bag', 'weapon', 'glasses')),
                  ('clothing', ('上衣', '外套', '裙', '裤', '袜', '丝袜', '鞋', '绑带', '衣',
                                'dress', 'skirt', 'shirt', 'jacket', 'coat', 'shoes', 'stockings', 'gloves')),
                  ('color', ('color', 'colour', '色')))
HAIR_MESH = re.compile(r'(?:^|_)hair', re.IGNORECASE)
# The files of an in-game panel's icons (si-df68a's res_panel), as opposed to textures.
IMAGES = ('.png', '.jpg', '.jpeg')
# The table's warnings the import's own warnings carry too.
REPORTED = ('setting_fixed', 'variant_unplaced', 'segment_unmappable')


@dataclass
class Setting:
    id: str
    name: str
    origin: dict
    # Variable -> value where it differs from the defaults, after that many presses of the key.
    states: list
    adult: bool = False
    # The stem of the panel icon shown for the switch, as `32_earrings`.
    icon: str | None = None


@dataclass
class Plan:
    """What the switches change of the default evaluation, per switch id."""
    settings: list
    # (component, (first, count)) -> {setting id: values} of a segment the defaults draw and some value hides.
    controlled: dict = field(default_factory=dict)
    # (component, (first, count)) -> (setting id, values, Segment as drawn) of a segment only other values draw.
    extras: dict = field(default_factory=dict)
    # (component, slot) -> (default file, [(setting id, value, file)]) of a slot that other values bind another file at.
    slots: dict = field(default_factory=dict)
    # Default `this` file -> [(setting id, value, file)] of the texture overrides that other values switch.
    this: dict = field(default_factory=dict)
    # (component, slot) -> [(setting id, value, default file, file, spans)] of a value binding another file at only the segments
    # `spans` ((first, count) each) of the component.
    partial: dict = field(default_factory=dict)
    # (component, (first, count)) -> Segment.split of each segment of `partial`.
    split: dict = field(default_factory=dict)
    fixed: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    # Setting id -> {value: name} of the values whose bound textures' resources name them.
    labels: dict = field(default_factory=dict)

    def used(self):
        """The ids of the switches that change anything, in table order."""
        ids = {i for when in self.controlled.values() for i in when} | {e[0] for e in self.extras.values()}
        ids |= {i for _, found in self.slots.values() for i, _, _ in found} | {i for found in self.this.values() for i, _, _ in found}
        ids |= {x[0] for found in self.partial.values() for x in found}
        return [s.id for s in self.settings if s.id in ids]

    def drop(self, sid):
        """Leave switch `sid` at its default: what only it changes is drawn as the defaults draw it."""
        for key, when in list(self.controlled.items()):
            when.pop(sid, None)
            if not when:del self.controlled[key]
        self.extras = {k: e for k, e in self.extras.items() if e[0] != sid}
        self.slots = {k: (f, [x for x in found if x[0] != sid]) for k, (f, found) in self.slots.items()}
        self.this = {k: [x for x in found if x[0] != sid] for k, found in self.this.items()}
        self.partial = {k: [x for x in found if x[0] != sid] for k, found in self.partial.items()}

    def warn(self, code):
        if code not in self.warnings:self.warnings.append(code)


def label(text):
    """`text` as a display name of at most LABEL_BYTES bytes, or None."""
    text = ' '.join(text.split())
    while len(text.encode()) > LABEL_BYTES:text = text[:-1]
    return text or None


def setting_id(variable, taken):
    """A switch id after `variable`, not one of `taken`."""
    base = re.sub(r'[^a-z0-9_]+', '_', variable.lstrip('$').split('\\')[-1].lower())
    base = re.sub(r'^[^a-z]+', '', base).rstrip('_')[:32] or 'setting'
    found, n = base, 1
    while found in taken:
        n += 1; found = base[:31-len(str(n))]+'_'+str(n)
    return found


def adult(text):
    """Whether a name tells of underwear or nudity."""
    low = text.lower()
    return any(p in low for p in ADULT_PARTS) or any(w.lower() in ADULT_WORDS for w in WORD.findall(text))


def presses(scene, section, start):
    """The states repeated presses of key `section` reach from `start`, `{}` first; one state when its values are no numbers."""
    kind = (section.get('type') or '').lower()
    lists = {}
    for e in section.entries:
        if not e.key.startswith('$'):continue
        try:lists[e.key] = [float(v) for v in e.value.split(',')]
        except ValueError:return [{}]
    runs = [efmi_mod.target(e.value) for e in section.entries if e.key == 'run']
    def zero(k):return start.get(k, 0.0)
    def press(state):
        now = dict(start, **state)
        for k, values in lists.items():
            v = now.get(k, 0.0)
            if kind == 'cycle' or (not kind and len(values) > 1):
                i = next((i for i, x in enumerate(values) if x == v), -1); now[k] = values[(i+1) % len(values)]
            elif kind in ('toggle', 'hold'):now[k] = zero(k) if v == values[0] else values[0]
            else:now[k] = values[0]
        for name in runs:
            run = efmi_mod.Run(scene, now)
            try:run.call(name, (), (), 0)
            except efmi_mod.Overrun:pass
            now = run.values
        return {k: v for k, v in now.items() if v != zero(k)}
    states = [{}]
    while len(states) < MAX_VALUES:
        state = press(states[-1])
        if state in states:break
        states.append(state)
    return states


def icons(mod):
    """Variable -> the stem of the image a section binds last before a line reading the variable: the icon an in-game panel
    shows for a switch."""
    images = {s.name.lower(): PurePosixPath(s.get('filename').replace('\\', '/')).stem for s in mod.sections
              if (s.get('filename') or '').lower().endswith(IMAGES)}
    out = {}
    for section in mod.sections:
        icon = None
        for e in section.entries:
            if efmi_mod.SLOT.fullmatch(e.key):icon = images.get(efmi_mod.target(e.value))
            elif e.key.startswith('$') and icon and VARIABLE.search(e.value):
                for v in VARIABLE.findall(e.value.lower()):out.setdefault(v, icon)
                icon = None
    return out


def read(mod):
    """The mod's switches in section order; a key whose presses change nothing, or a variable an earlier key sets, is left out.
    A switch is named by the comment of its key, else its panel icon, else its variable."""
    scene = efmi_mod.Scene(mod)
    found = icons(mod)
    out, taken, governed = [], set(), set()
    for section in mod.sections:
        if not section.name.lower().startswith('key'):continue
        states = presses(scene, section, mod.defaults)
        variables = list(dict.fromkeys(k for s in states for k in s))
        if len(states) < 2 or governed & set(variables):continue
        governed.update(variables)
        sid = setting_id(variables[0], taken); taken.add(sid)
        icon = next((found[v] for v in variables if v in found), None)
        name = label(section.comment or '') or label(re.sub(r'^\d+[_\s]*', '', icon or '').replace('_', ' ')) or \
            label(variables[0].lstrip('$').split('\\')[-1]) or sid
        origin = dict(section=section.name, variable=variables[0], **{k: section.get(k) for k in ('key', 'type') if section.get(k)})
        out.append(Setting(sid, name, origin, states, any(adult(t) for t in (section.name, section.comment or '', icon or '', *variables)), icon))
    return out


def key_lists(mod):
    """The lower-cased names of the [Constants] and key sections and of the command lists keys run."""
    by_name = {s.name.lower(): s for s in mod.sections}
    out = {'constants'}
    todo = [n for n in by_name if n.startswith('key')]
    while todo:
        name = todo.pop()
        if name in out or name not in by_name:continue
        out.add(name)
        todo += [efmi_mod.target(e.value) for e in by_name[name].entries if efmi_mod.phase_key(e.key) == 'run']
    return out


def this_files(mod, values):
    """Texture override section -> (its first `this` file, its `this` file at `values`) of each section binding `this`."""
    resources = {s.name.lower(): s.get('filename').replace('\\', '/') for s in mod.sections if s.get('filename')}
    out = {}
    for o in mod.overrides:
        lines = [e for e in o.lines if e.key == 'this' and efmi_mod.target(e.value) in resources]
        if not lines or not o.keys.get('this'):continue
        live = [e for e in lines if efmi_mod.active(e, values)]
        out[o.section] = (resources.get(efmi_mod.target(o.keys['this'])), resources[efmi_mod.target(live[-1].value)] if live else None)
    return out


class Switches:
    """The mod's switches and the variables evaluating the mod at their values needs."""

    def __init__(self, mod):
        self.mod = mod
        self.settings = read(mod)
        self.own = {k for s in self.settings for state in s.states for k in state}
        skip = key_lists(mod)
        # Lines outside the keys that compute a variable, which may follow a switch's (aster-toggle's CommandListProcessToggles).
        self.lines = [e for s in mod.sections if s.name.lower() not in skip for e in s.entries
                      if e.key.startswith('$') and '[' not in e.key and '\\' not in e.key and e.key not in self.own]

    def derived(self, values):
        """`values` with every variable those lines compute from a switch's variable recomputed, in file order."""
        out, sources = dict(values), set(self.own)
        def lookup(name):return None if name.endswith('->format') else out.get(name)
        for _ in range(2):
            for e in self.lines:
                if not sources & set(VARIABLE.findall(e.value.lower())) or not efmi_mod.active(e, out):continue
                value = efmi_mod.calculate(e.value, lookup)[0]
                if value is not None:out[e.key] = value; sources.add(e.key)
        return out

    def at(self, base, state):
        """The variables to evaluate the mod with: `base`, a switch's `state` and the derived variables it changes."""
        start = dict(self.mod.defaults, **base)
        before, after = self.derived(start), self.derived(dict(start, **state))
        out = dict(base); out.update(state); out.update({k: v for k, v in after.items() if k not in state and before.get(k) != v})
        return out

    def pin(self, base):
        """(variables holding each underwear switch at the value whose drawn segments hold the most indices, the lower of a tie,
        their ids)."""
        pinned, ids = dict(base), []
        for s in self.settings:
            if not s.adult:continue
            totals = [sum(seg.count for c in efmi_mod.components(self.mod, self.at(base, state)).values()
                          for seg in efmi_geometry.kept_segments(self.mod, c)) for state in s.states]
            pinned.update(self.at(base, s.states[totals.index(max(totals))])); ids.append(s.id)
        return pinned, ids

    def plan(self, base, default, shown, evaluate):
        """The Plan of the listed switches over `base`: `default` is the import's evaluation (component id -> Component),
        `shown` the components it draws (id -> mesh) and evaluate(values) the same evaluation at other values."""
        mod = self.mod
        plan = Plan([s for s in self.settings if not s.adult])
        sections = {cid: c.section for cid, c in default.items()}
        def drawn(components):
            out = {}
            for cid in shown:
                if cid in components:
                    for s in efmi_geometry.kept_segments(mod, components[cid]):out.setdefault((cid, (s.first, s.count)), s)
            return out
        overrides = this_files(mod, dict(mod.defaults, **base))
        # A `this` of a file switches through this_files; its segments' `hash:` slot would count the switch twice.
        covered = {'hash:'+o.hash for o in mod.overrides if o.section in overrides}
        def bound(segments):
            out = {}
            for (cid, _), s in segments.items():
                for slot, f in efmi_geometry.slot_files(s.textures).items():
                    if slot not in covered:out.setdefault((cid, slot), set()).add(f)
            return out
        start = drawn(default); files = bound(start)
        seen, found, slots, this = {}, {}, {}, {}
        for s in plan.settings:
            for v, state in enumerate(s.states[1:], 1):
                values = self.at(base, state)
                components = evaluate(values)
                # Another buffer's ranges are no ranges of the default one.
                moved = {cid for cid in shown if cid in components and cid in default and components[cid].ib != default[cid].ib}
                for cid in sorted(moved):plan.warn('segment_unmappable:'+sections[cid])
                now = {k: seg for k, seg in drawn(components).items() if k[0] not in moved}
                now.update({k: seg for k, seg in start.items() if k[0] in moved})
                for k, seg in now.items():
                    seen.setdefault(k, {}).setdefault(s.id, set()).add(v); found.setdefault((k, s.id), seg)
                for key, fs in bound(now).items():
                    if not fs - files.get(key, set()):continue
                    # The segments drawn at the defaults too whose file for the slot changes: (default file, file) by span.
                    parts = {}
                    for k, seg in now.items():
                        if k[0] != key[0] or k not in start:continue
                        d, f = (efmi_geometry.slot_files(x.textures).get(key[1]) for x in (start[k], seg))
                        if f != d:parts[k[1]] = (d, f)
                    slots.setdefault(key, []).append((s.id, v, fs, parts))
                for section, (first, f) in this_files(mod, dict(mod.defaults, **values)).items():
                    if f != overrides[section][1]:this.setdefault(section, []).append((s.id, v, f))
        for k in sorted(set(start) | set(seen)):
            hit = seen.get(k, {})
            if k in start:
                when = {s.id: sorted({0} | hit.get(s.id, set())) for s in plan.settings}
                when = {i: vals for i, vals in when.items() if len(vals) < len(next(s for s in plan.settings if s.id == i).states)}
                if when:plan.controlled[k] = when
            elif len(hit) == 1:
                [(sid, vals)] = hit.items(); plan.extras[k] = (sid, sorted(vals), found[k, sid])
            else:plan.warn('condition_unsupported:'+sections[k[0]])
        owner = {var: s.id for s in plan.settings for state in s.states for var in state}
        for o in mod.overrides:
            if o.component not in shown:continue
            for e in o.lines:
                tests = [t for earlier, test in e.conditions for t in (*earlier, test) if t]
                if not e.key.startswith('drawindexed') or not any(len({owner[x] for x in VARIABLE.findall(t.lower()) if x in owner}) > 1 for t in tests):
                    continue
                # A test of two switches is no condition of one switch's values: the segment stays as the defaults draw it.
                d = efmi_mod.draw_call(e); key = (o.component, (d.first, d.count))
                plan.controlled.pop(key, None); plan.extras.pop(key, None); plan.warn('condition_unsupported:'+o.section)
        for key, changes in slots.items():
            before = files.get(key, set())
            for sid, v, fs, parts in changes:
                pairs = set(parts.values())
                if len(before) == 1 and len(fs) == 1:plan.slots.setdefault(key, (next(iter(before)), []))[1].append((sid, v, next(iter(fs))))
                elif len(pairs) == 1 and None not in next(iter(pairs)):
                    [(d, f)] = pairs; plan.partial.setdefault(key, []).append((sid, v, d, f, sorted(parts)))
                else:plan.warn('variant_unplaced:'+', '.join(sorted(fs - before)))
        for section, changes in this.items():
            first, now = overrides[section]
            if first is None or now != first:plan.warn('condition_unsupported:'+section); continue
            for sid, v, f in changes:
                if f is None:plan.warn('condition_unsupported:'+section)
                # The sections of one texture's hashes (full, mid, low) switch it alike.
                elif (sid, v, f) not in plan.this.get(first, []):plan.this.setdefault(first, []).append((sid, v, f))
        bound = {}
        for default_file, changes in [*plan.slots.values(), *plan.this.items()]:
            for sid, v, f in changes:bound.setdefault(sid, {0: set()})[0].add(default_file); bound[sid].setdefault(v, set()).add(f)
        for sid, v, default_file, f, _ in (x for found in plan.partial.values() for x in found):
            bound.setdefault(sid, {0: set()})[0].add(default_file); bound[sid].setdefault(v, set()).add(f)
        plan.labels = {s.id: value_names(mod, s, bound[s.id]) for s in plan.settings if s.id in bound}
        used = plan.used()
        for sid in used[MAX_SETTINGS:]:plan.drop(sid)
        while len(plan.controlled)+len(plan.extras) > MAX_SEGMENTS:plan.drop(plan.used()[-1])
        for sid in used:
            if sid not in plan.used():plan.fixed.append(sid); plan.warn('setting_fixed:'+sid)
        split = {}
        for (cid, slot), found in plan.partial.items():
            for sid, v, _, _, spans in found:
                for span in spans:split.setdefault((cid, span), []).append((slot, sid, v))
        plan.split = {k: tuple(sorted(x)) for k, x in split.items()}
        return plan


def value_names(mod, setting, bound):
    """Value -> the last word of the names of the resources binding its files in `bound` (value -> files), as `Red` of
    Resource_Texture_Hair_Red; of a file several resources name, those a line under a test of the switch's variables binds."""
    variables = {k for state in setting.states for k in state}
    by_file, switched = {}, set()
    for section in mod.sections:
        if section.get('filename'):by_file.setdefault(section.get('filename').replace('\\', '/'), []).append(section.name)
        for e in section.entries:
            tests = [t for earlier, test in e.conditions for t in (*earlier, test) if t]
            if (e.key == 'this' or efmi_mod.SLOT.fullmatch(e.key)) and any(variables & set(VARIABLE.findall(t.lower())) for t in tests):
                switched.add(efmi_mod.target(e.value))
    out = {}
    for v, files in bound.items():
        ends = set()
        for f in files:
            names = by_file.get(f, [])
            ends |= {n.rsplit('_', 1)[1] if '_' in n else None for n in [n for n in names if n.lower() in switched] or names} or {None}
        if len(ends) == 1 and (end := label(ends.pop() or '')):out[v] = end
    return out


def groups(mod, component, controlled, warn):
    """(condition, runs, spans) of each index group efmi_geometry.index_groups makes of `component`, `spans` the (first, count)
    of its segments. A group of segments with a MARK condition, a plan's extras, is drawn under its switch's values; a group of
    the defaults' segments hides the runs `controlled` ((first, count) -> condition) names, adjacent runs of one condition joined."""
    found = {}
    for s in efmi_geometry.kept_segments(mod, component):
        found.setdefault((tuple(sorted(s.textures.items())), s.condition, s.split), []).append(s)
    out = []
    for (_, condition, _), segments in found.items():
        spans = [(s.first, s.count) for s in segments]
        if condition[:1] == (MARK,):out.append(({condition[1]: list(condition[2])}, [], spans)); continue
        runs, offset = [], 0
        for s in segments:
            when = controlled.get((s.first, s.count))
            if when is not None and (offset % 3 or s.count % 3):warn('segment_unmappable:'+component.section)
            elif when is not None and runs and runs[-1][2] == when and sum(runs[-1][:2]) == offset:runs[-1] = (runs[-1][0], runs[-1][1]+s.count, when)
            elif when is not None:runs.append((offset, s.count, copy.deepcopy(when)))
            offset += s.count
        if len(runs) > MAX_RUNS:warn('condition_unsupported:'+component.section); runs = runs[:MAX_RUNS]
        out.append((None, runs, spans))
    return out


def block_runs(mod, component, first_index, draws, read_blob, controlled, warn):
    """(indices sha256, runs) on the template block a component without geometry of its own draws, or None: its draw calls index
    its own buffer, which must equal the block, or the game's, whose ranges start at `first_index`."""
    if not controlled:return None
    ib = component.ib or {}
    if ib.get('file') in mod.files:
        width = efmi_geometry.INDEX_FORMATS.get(ib.get('format'))
        raw = mod.files[ib['file']].read_bytes()
        own = mesh_codec.widen_indices(raw, width) if width and len(raw) % width == 0 else None
        hit = next((d for d in draws if own is not None and mesh_codec.widen_indices(read_blob(d['indices']), d['index_component_bytes']) == own), None)
        offset = 0
    else:
        try:hit = efmi_geometry.template_submesh(component, draws, read_blob)[1]
        except ValueError:hit = None
        offset = first_index
    if hit is None:warn('segment_unmappable:'+component.section); return None
    runs = []
    for (first, count), when in sorted(controlled.items()):
        f = first-offset
        if f < 0 or f % 3 or count % 3 or f+count > hit['index_count'] or (runs and sum(runs[-1][:2]) > f):
            warn('segment_unmappable:'+component.section)
        elif runs and runs[-1][2] == when and sum(runs[-1][:2]) == f:runs[-1] = (runs[-1][0], runs[-1][1]+count, when)
        else:runs.append((f, count, copy.deepcopy(when)))
    if len(runs) > MAX_RUNS:warn('condition_unsupported:'+component.section); runs = runs[:MAX_RUNS]
    return hit['indices']['sha256'], runs


def place_variants(appearance, source, items, read, put, warn):
    """(texture_variants entries, textures[] of the table, bytes stored) of `items`, (setting id, value, clone mesh, resource,
    file, index block sha256 or None for every draw of the mesh) in table order; read(file) is its TextureBlob, put(raw) stores
    a blob beside the source manifest. A file of fewer mip levels than its slot gets the slot's (texture_mips). A switch whose
    variants would pass MAX_VARIANTS or MAX_VARIANT_BYTES keeps its defaults' textures."""
    placed, count, stored, size = [], 0, {}, 0
    for sid in dict.fromkeys(i[0] for i in items):
        mine, files = [], {}
        for _, v, mesh, resource, f, block in (i for i in items if i[0] == sid):
            try:blob = read(f)
            except ValueError:warn('variant_unplaced:'+f); continue
            slots = [r for d in source['draws'] if d['mesh'] == mesh and (block is None or d['indices']['sha256'] == block) for r in d['resources']
                     if r['category'] == 'separate_images' and r.get('texture') and resource in r['names']]
            levels = slots[0]['texture']['mip_count'] if slots else 0
            mips = texture_mips.chain(blob.rd_format_name, blob.width, blob.height, levels) \
                if len(blob.mips) < levels and blob.rd_format_name in texture_mips.CODECS else blob.mips
            spec = dict(slots[0]['texture'], width=blob.width, height=blob.height, mip_count=len(mips), rd_format_name=blob.rd_format_name,
                        mips=copy.deepcopy(mips)) if slots else None
            if spec is None or any({k: r['texture'].get(k) for k in ('rd_format_name', 'width', 'height', 'mip_count')} !=
                                   {k: spec[k] for k in ('rd_format_name', 'width', 'height', 'mip_count')} for r in slots):
                warn('variant_unplaced:'+f); continue
            # A file placed in slots of other mip counts is stored once a count.
            mine.append((v, mesh, resource, (f, len(mips)), spec, slots[0]['names'], block)); files[f, len(mips)] = blob
        new = {f: x for f, x in files.items() if f not in stored}
        grown = sum(m['size'] for (_, n), b in new.items() for m in texture_mips.chain(b.rd_format_name, b.width, b.height, n))
        if count+len(mine) > MAX_VARIANTS or size+grown > MAX_VARIANT_BYTES:
            warn('variants_too_large:'+sid); continue
        stored.update(new); size += grown; count += len(mine)
        placed.append((sid, mine))
    order = list(stored)
    blobs = dict(zip(order, texture_mips.fill_all([(stored[k], k[1]) for k in order])))
    entries, textures = [], {}
    for sid, mine in placed:
        for v, mesh, resource, f, spec, names, block in mine:
            variant = '/'.join((appearance, mesh.split('/', 1)[-1], *([block[:12]] if block else []), resource, sid, str(v)))
            entries.append(dict(id=variant, mesh=mesh, **(dict(indices_sha256=block) if block else {}), resource_names=list(names),
                                **put(blobs[f].data), texture=spec))
            textures.setdefault((mesh, block, resource), []).append(dict(variant=variant, when={sid: [v]}))
    return entries, [dict(mesh=m, **(dict(indices_sha256=b) if b else {}), resource=r, variants=v) for (m, b, r), v in textures.items()], size


def category(setting, segments):
    """What a switch changes: color when it draws no segment of its own, hair when all of them are on hair meshes, else what
    the words of its name, icon and variables tell (CATEGORY_WORDS), else other."""
    if not segments:return 'color'
    if all(HAIR_MESH.search(s['mesh'].rsplit('/', 1)[-1]) for s in segments):return 'hair'
    words = ' '.join([setting.name, setting.icon or '', *(k for state in setting.states for k in state)]).lower()
    return next((c for c, keys in CATEGORY_WORDS if any(k in words for k in keys)), 'other')


def entry(plan, segments, textures):
    """The table's entry of one appearance: the switches its segments and textures name. A value is named by its textures'
    resources (Plan.labels), else, of two values one of which draws none of the switch's segments, 显示 or 隐藏, else 选项 N."""
    named = {i for s in segments for i in s['visible_when']} | {i for t in textures for v in t['variants'] for i in v['when']}
    settings = []
    for s in plan.settings:
        if s.id not in named:continue
        mine = [g for g in segments if s.id in g['visible_when']]
        hidden = [v for v in range(len(s.states)) if mine and all(v not in g['visible_when'][s.id] for g in mine)]
        def name(v):
            if v in plan.labels.get(s.id, {}):return plan.labels[s.id][v]
            if len(s.states) == 2 and len(hidden) == 1:return '隐藏' if v in hidden else '显示'
            return f'选项 {v+1}'
        settings.append(dict(id=s.id, name=s.name, category=category(s, mine), values=[dict(value=v, name=name(v)) for v in range(len(s.states))],
                             default=0, origin=s.origin))
    return dict(settings=settings, segments=segments, textures=textures)
