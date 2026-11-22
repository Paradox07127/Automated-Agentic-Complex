"""Second-level motion selection: which clip the character starts, when, and why, from a character directory's c7 tables
(`runtime/characters/<id>/`). It makes the same choices as the mac renderer's `ActorMotionController` and models the
playhead from the manifest's clip lengths instead of sampling animation.

    chooser = MotionChooser(character_dir)
    chooser.send({"kind": "intent", "intent": "think", "state": "thinking"})   # the scenario input kinds
    chooser.tick(1 / 60)                                                       # -> [{t_s, clip, why}, ...]

Times and lengths are 32-bit floats, as in the controller, so frame-edge decisions fall on the same frames."""
from dataclasses import dataclass, field
import json
import logging
import math
from pathlib import Path
import struct

LOG = logging.getLogger(__name__)
_F32 = struct.Struct("<f")


def f32(x):
    return _F32.unpack(_F32.pack(x))[0]


EPS = f32(0.00001)
POSTURES = frozenset(["stand", "sit", "floor", "lie", "air", "boss"])
LIFTED = frozenset(["air", "boss"])
INTENTS = frozenset(["idle", "listen", "think", "speak", "greet", "acknowledge", "explain", "offer", "uncertain",
                     "reassure", "celebrate", "apologize"])
SESSION_EVENTS = {"thinking": "session.thinking", "compacting": "session.thinking", "running_tool": "session.tool",
                  "subagent": "session.subagent", "awaiting_approval": "session.approval",
                  "awaiting_input": "session.input", "error": "session.error", "done": "session.done",
                  "stale": "session.stale", "background": "session.background"}
ONE_SHOT_SESSIONS = frozenset(["session.done", "session.error"])
URGENT_EVENTS = frozenset(["session.approval", "session.input", "session.error"])
BUSY_EVENTS = frozenset(["session.thinking", "session.tool"])
SESSION_COOLDOWNS = frozenset(["session.approval", "session.input"])
ONE_SHOT_ACTIVITIES = ("idle", "relax", "fidget", "think", "wait", "react", "welcome_back", "welcome_small", "yawn",
                       "sleep")
# fly and guard in a pack without them.
ACTIVITY_STAND_INS = {"fly": "think", "guard": "relax"}
REGION_KEYS = {"cheek_l": ["click.cheek", "click.face"], "cheek_r": ["click.cheek", "click.face"],
               "head_top": ["click.head"], "hand_l": ["click.hand"], "hand_r": ["click.hand"]}
DEFAULT_BUDGET = {"idle_per_min": 2, "idle_gap_s": 15, "busy_per_min": 4, "seated_per_min": 1}
# Blend seconds over a pose gap in centimetres: linear between the points, flat outside.
BLEND_CURVE = [(f32(cm), f32(s)) for cm, s in [(8, 0.25), (25, 0.6), (40, 0.9), (55, 0.9), (75, 1.2)]]
SEAMLESS_CM = BLEND_CURVE[0][0]
EXCLUDED_FAMILIES = frozenset(["boss", "other"])
# The six random streams and their seeds; one step is the 32-bit LCG x = 1664525 x + 1013904223.
SEEDS = {"activity": 1018, "event": 2110, "tier": 1021, "fidget": 20261018, "gesture": 2026, "click": 1810}
HISTORY = 16
SEAT_BLEND = f32(0.25)
SEAT_HOLD_S = f32(8)


def lcg(x):
    return (1664525 * x + 1013904223) & 0xFFFFFFFF


def blend_seconds(gap):
    p = BLEND_CURVE
    if gap <= p[0][0]:
        return p[0][1]
    for (ac, as_), (bc, bs) in zip(p, p[1:]):
        if gap <= bc:
            return f32(as_ + f32(f32(f32(bs - as_) * f32(gap - ac)) / f32(bc - ac)))
    return p[-1][1]


def _floats(x):
    return None if x is None else [f32(v) for v in x]


def _read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


@dataclass
class Entry:
    intents: list = field(default_factory=list)
    next: str = None
    exit: str = None
    hold_seconds: float = None
    interruptible: bool = None
    end_at_length: bool = None
    hold_policy: str = None
    exit_condition: str = None
    idle_variants: list = None
    idle_interval_s: list = None
    complete_on_enter: bool = None

    @classmethod
    def load(cls, row):
        return cls(intents=row.get("intents") or [], next=row.get("next"), exit=row.get("exit"),
                   hold_seconds=None if row.get("hold_seconds") is None else f32(row["hold_seconds"]),
                   interruptible=row.get("interruptible"), end_at_length=row.get("end_at_length"),
                   hold_policy=row.get("hold_policy"), exit_condition=row.get("exit_condition"),
                   idle_variants=row.get("idle_variants"), idle_interval_s=_floats(row.get("idle_interval_s")),
                   complete_on_enter=row.get("complete_on_enter"))

    @property
    def held(self):
        return self.hold_policy == "while_requested"


@dataclass
class Rule:
    loop: bool
    return_clip: str = None
    return_at: float = None
    return_blend: float = None
    return_fixed: bool = False


@dataclass
class Event:
    pool: list
    interrupt: str
    cooldown_s: float
    no_repeat: int
    repick_gap_s: list


@dataclass
class Tier:
    pool: list
    after_s: list
    interval_s: list
    min_gap_s: dict
    no_repeat: int
    stance: str


class PoseFamilies:
    """animation/pose-families.json: base loops, bridges between them, each clip's start and end family."""

    def __init__(self, doc):
        self.bases = doc["bases"]
        self.base_clips = set(self.bases.values())
        self.hub = doc["hub"]
        self.bridges = doc["bridges"]
        self.gaps = {a: {b: f32(v) for b, v in row.items()} for a, row in doc["family_gaps_cm"].items()}
        self.clips = {c: (r["start"], r["end"], f32(r["start_cm"]), f32(r["end_cm"])) for c, r in doc["clips"].items()}
        self._base_family = {clip: family for family, clip in self.bases.items()}

    def family(self, clip):
        return self._base_family.get(clip) or (self.clips[clip][1] if clip in self.clips else None)

    def start_family(self, clip):
        return self._base_family.get(clip) or (self.clips[clip][0] if clip in self.clips else None)

    def gap_cm(self, a_clip, b_clip):
        a, b = self.family(a_clip), self.start_family(b_clip)
        if a is None or b is None:
            return None
        end = 0.0 if a_clip in self.base_clips else (self.clips[a_clip][3] if a_clip in self.clips else 0.0)
        start = 0.0 if b_clip in self.base_clips else (self.clips[b_clip][2] if b_clip in self.clips else 0.0)
        if a == b:
            return f32(end + start) if a in self.bases else None
        gap = self.gaps.get(a, {}).get(b)
        if gap is None:
            gap = self.gaps.get(b, {}).get(a)
        if gap is not None:
            return gap
        sides = [v for v in [end if a not in self.bases else None, start if b not in self.bases else None]
                 if v is not None]
        return max(sides) if sides else None

    def redraw_gap_cm(self, loop, clip):
        gaps = [g for g in (self.gap_cm(loop, clip), self.gap_cm(clip, loop)) if g is not None]
        return max(gaps) if gaps else None


class Pack:
    """The policy tables of one character directory."""

    def __init__(self, root):
        root = Path(root)
        self.id = root.name
        c7 = root / "c7"
        pack = _read(c7 / "pack.json")
        animation = {r["file"] for r in pack["animation"]["data"]}
        manifest = {c["name"]: c for c in _read(root / "actor" / "manifest.json")["clips"]}
        self.lengths = {name: f32(c["length"]) for name, c in manifest.items()}
        rows = _read(c7 / "animation" / pack["animation"]["palette_contract"]["file"])["clips"]
        if "supplemental-clips.json" in animation:
            rows = rows + _read(c7 / "animation" / "supplemental-clips.json")["clips"]
        self.rules = {r["name"]: Rule(loop=r["loop"], return_clip=r.get("auto_return_clip"),
                                      return_at=None if r.get("auto_return_exit_normalized") is None
                                      else f32(r["auto_return_exit_normalized"]),
                                      return_blend=None if r.get("auto_return_blend") is None
                                      else f32(r["auto_return_blend"]),
                                      return_fixed=r.get("auto_return_fixed_seconds") is True)
                      for r in rows if r["name"] in manifest}
        self.returns = {name: r.return_clip for name, r in self.rules.items() if r.return_clip}
        m = _read(c7 / "animation" / "intent-motion-map.json")
        self.map = m
        named = self._named_clips(m)
        absent = sorted(named - set(manifest))
        LOG.info("motion: %s: %d clips the c7 tables name are not in actor/manifest.json", self.id, len(absent))
        self.absent = set(absent)
        keep = lambda c: c in manifest  # noqa: E731
        self.crossfade = f32(m["crossfade_seconds"])
        self.ordered = [c for c in m["clips"] if keep(c)]
        self.entries = {c: Entry.load(m["clips"][c]) for c in self.ordered}
        metadata = _read(c7 / "interaction" / "motion-metadata.json")["clips"]
        self.stances = {c: (r["stance_start"], r["stance_end"]) for c, r in metadata.items()}
        blends = _read(c7 / "interaction" / "blend-times.json")["clips"]
        self.blend_in = {c: f32(r["blend_in_s"]) for c, r in blends.items()}
        self.blend_out = {c: f32(r["blend_out_s"]) for c, r in blends.items() if r.get("blend_out_s") is not None}
        bindings = _read(c7 / "animation" / "motion-bindings.json")
        self.overview, self.relax, self.from_overview = bindings["overview"], bindings["relax"], bindings["from_overview"]
        self.families = None
        if "pose-families.json" in animation:
            self.families = PoseFamilies(_read(c7 / "animation" / "pose-families.json"))
            self.normal = self.families.bases[self.families.hub]
            self.idle_bases = {self.normal, self.relax}
            # The hub rests like the relax base: a terminal idle loop, not a timed chain clip.
            if self.normal in self.entries:
                self.entries[self.normal] = Entry(intents=self.entries[self.normal].intents, interruptible=True,
                                                  complete_on_enter=True)
        else:
            self.normal = self.overview
            self.idle_bases = set(bindings.get("idle_bases") or [self.overview])
        self.library = m.get("motion_library") or {}
        self.contexts = {}
        for clip, row in self.library.items():
            if row.get("reviewed") is True and keep(clip):
                for context in dict.fromkeys(row.get("contexts") or []):
                    self.contexts.setdefault(context, []).append(clip)
        pool = lambda rows: [(r["clip"], 1 if r.get("weight") is None else r["weight"])  # noqa: E731
                             for r in rows if keep(r["clip"])]
        self.events = {k: Event(pool(e["pool"]), e["interrupt"], f32(e.get("cooldown_s") or 0), e.get("no_repeat"),
                                _floats(e.get("repick_gap_s"))) for k, e in (m.get("events") or {}).items()}
        self.event_names = {k.split("@", 1)[0] for k in self.events}
        self.tiers = None if m.get("idle_tiers") is None else [
            Tier(pool(t["pool"]), _floats(t["after_s"]), _floats(t.get("interval_s")),
                 {c: f32(s) for c, s in (t.get("min_gap_s") or {}).items()}, t.get("no_repeat"), t.get("stance"))
            for t in m["idle_tiers"]]
        self.activities = None if m.get("activities") is None else {
            name: {mood: [c for c in clips if keep(c)] for mood, clips in lists.items()}
            for name, lists in m["activities"].items()}
        gestures = m.get("speech_gestures")
        self.gestures = None if gestures is None else ([c for c in gestures["clips"] if keep(c)],
                                                       _floats(gestures["interval_seconds"]))
        self.fidget = ([c for c in m["idle_fidget"]["clips"] if keep(c)], _floats(m["idle_fidget"]["interval_seconds"]))
        self.click_reactions = None if m.get("click_reactions") is None else [
            c for c in m["click_reactions"] if keep(c)]
        self.excluded = self._excluded(m)
        budget = m.get("motion_budget")
        self.budget = None
        if budget is not None or self.families is not None:
            b = dict(DEFAULT_BUDGET, **{k: v for k, v in (budget or {}).items() if v is not None})
            self.budget = (b["idle_per_min"], f32(b["idle_gap_s"]), b["busy_per_min"], b["seated_per_min"])
        self.disabled = self._disabled(c7)
        self.tier_postures = [t.stance or self._held_posture(t) for t in self.tiers or []]
        self.tier_clips = set()
        for i, t in enumerate(self.tiers or []):
            for c in [c for c, _ in t.pool] + self.contexts.get("idle.t%d" % (i + 1), []):
                for x in self.chain(c):
                    self.tier_clips.add(x)
                    if x in self.entries and self.entries[x].exit:
                        self.tier_clips.update(self.chain(self.entries[x].exit))
        self.c7 = c7

    @staticmethod
    def _named_clips(m):
        named = set(m["clips"]) | set(m.get("motion_library") or {}) | set(m["idle_fidget"]["clips"])
        named |= {r["clip"] for e in (m.get("events") or {}).values() for r in e["pool"]}
        named |= {r["clip"] for t in m.get("idle_tiers") or [] for r in t["pool"]}
        named |= {c for lists in (m.get("activities") or {}).values() for clips in lists.values() for c in clips}
        named |= set((m.get("speech_gestures") or {}).get("clips") or []) | set(m.get("click_reactions") or [])
        return named

    def _held_posture(self, tier):
        held = {p for c, _ in tier.pool for p in (self.stances[c][0] if c in self.stances else "stand",
                                                  self.posture(c))}
        return next(iter(held)) if len(held) == 1 and next(iter(held)) in POSTURES else "stand"

    def _excluded(self, m):
        """Standing pool clips that start, or whose chain comes to rest, in a family no desktop pool draws from."""
        f = self.families
        if f is None:
            return {}
        pooled = {c for clips in self.contexts.values() for c in clips}
        pooled |= {c for e in self.events.values() for c, _ in e.pool} | {c for t in self.tiers or [] for c, _ in t.pool}
        pooled |= set(self.fidget[0]) | set(self.gestures[0] if self.gestures else []) | set(self.click_reactions or [])
        pooled |= {c for lists in (self.activities or {}).values() for clips in lists.values() for c in clips}
        raw = m["clips"]

        def last(c):
            seen = set()
            while c not in seen:
                seen.add(c)
                n = self.returns.get(c) or (raw.get(c) or {}).get("next") or (raw.get(c) or {}).get("exit")
                if not n:
                    break
                c = n
            return c
        excluded = {}
        for c in sorted(pooled):
            stance = self.stances[c][0] if c in self.stances else "stand"
            if stance in POSTURES and stance != "stand" and stance not in LIFTED:
                continue
            if (self.library.get(c) or {}).get("unbridged") or c not in f.clips:
                continue
            end = f.clips[last(c)][1] if last(c) in f.clips else None
            family = next((x for x in (f.clips[c][0], end) if x in EXCLUDED_FAMILIES), None)
            if family:
                excluded[c] = family
        return excluded

    def _disabled(self, c7):
        """The clips of the action rows that are off by default or unavailable."""
        rows = []
        for section in ("animation", "interaction"):
            rows += _read(c7 / section / "actions.json")["actions"]
        missing = {r["id"] for r in rows if r.get("unavailable_reason") is not None
                   or any(c not in self.rules for c in (r.get("clips") or []) + (r.get("required_clips") or []))}
        on = {r["id"]: r["id"] not in missing and (r.get("required_reason") is not None
                                                   or r.get("default_enabled") is not False) for r in rows}
        for section in ("talk", "react", "idle", "touch"):
            live = [r for r in rows if r["section"] == section and r["id"] not in missing]
            if live and not any(on[r["id"]] for r in live):
                on[live[0]["id"]] = True
        return {c for r in rows if not on[r["id"]] for c in r.get("clips") or []}

    def loop(self, clip):
        return clip in self.rules and self.rules[clip].loop

    def posture(self, clip):
        s = self.stances[clip][1] if clip in self.stances else "stand"
        return s if s in POSTURES else "stand"

    def event_key(self, event, posture):
        keys = [event, event + "@stand"] if posture == "stand" else [event + "@" + posture]
        return next((k for k in keys if k in self.events), None)

    def family(self, clip):
        return (self.library.get(clip) or {}).get("family") or clip

    def weight(self, clip, context, mood=None):
        e = self.library.get(clip) or {}
        w = (e.get("context_weights") or {}).get(context)
        if w is None:
            w = 1 if e.get("weight") is None else e["weight"]
        return w * 2 if mood is not None and mood in (e.get("moods") or []) else w

    def primary(self, intent):
        return next((c for c in self.ordered if intent in self.entries[c].intents), None)

    def next_clip(self, clip):
        return self.returns.get(clip) or (self.entries[clip].next if clip in self.entries else None)

    def chain(self, start):
        result, c = [], start
        while c is not None and c not in result:
            result.append(c)
            c = self.next_clip(c)
        return result

    def requested_loop(self, start):
        return next((c for c in self.chain(start) if c in self.entries and self.entries[c].held), None)


class Playhead:
    """The animator's clock: the active clip and its time, and the clip it blends to."""

    def __init__(self, clip):
        self.active, self.time, self.target, self.target_time = clip, 0.0, None, 0.0
        self.blend_elapsed = self.blend_duration = 0.0
        self.first = True

    @property
    def current(self):
        return self.target or self.active

    def transition(self, clip, duration, start_time=None):
        if self.target == clip or (self.active == clip and self.target is None):
            return
        self.target, self.blend_elapsed, self.blend_duration = clip, 0.0, duration
        self.target_time = start_time if start_time is not None else (self.time if clip == self.active else 0.0)

    def advance(self, dt):
        dt = 0.0 if self.first else dt
        self.first = False
        self.time = f32(self.time + dt)
        if self.target is not None:
            self.target_time = f32(self.target_time + dt)
            self.blend_elapsed = f32(self.blend_elapsed + dt)
            if self.blend_elapsed >= self.blend_duration:
                self.active, self.time, self.target = self.target, self.target_time, None
        return dt


@dataclass
class Requested:
    start: str
    owner: tuple
    stopping: bool = False
    exiting: bool = False


@dataclass
class Staged:
    clip: str
    duration: float
    source_duration: bool
    entry: bool
    base: str
    start_time: float


@dataclass
class Seat:
    id: str
    enter: str
    loop: str
    seated: bool = False
    boundary: float = None
    detour: tuple = None


@dataclass
class Pat:
    start: str
    leave: bool = False
    left: bool = False
    entered: bool = False


class MotionChooser:
    """One character's motion selection. `send` takes a scenario input, `tick` advances the clock; both return the
    clips started, each as {t_s, clip, why}."""

    def __init__(self, character_dir):
        self.pack = Pack(character_dir)
        self.t_s = 0.0
        self.choices = []
        self._restart()

    # Inputs and the clock.

    def send(self, item):
        kind = item["kind"]
        start = len(self.choices)
        if kind == "restart":
            self._restart()
        elif kind == "sit":
            use = next(u for u in _read(self.pack.c7 / "interaction" / "affordance-uses.json")["uses"]
                       if u["surface"] == "seat" and u.get("enter"))
            self._seat = Seat(use["id"], use["enter"], use["loop"])
            self._call(("seat", "seat", "enter " + use["id"]), lambda: self.acquire_exact(use["enter"], SEAT_BLEND))
        elif kind == "pat_end":
            if self._pat:
                self._pat.leave = True
        elif kind == "stand":
            self._call(("input", item), self._stand)
        else:
            self._call(("input", item), lambda: self._perform(item))
        return self.choices[start:]

    def tick(self, dt_s=1 / 60):
        start = len(self.choices)
        self._seat_step()
        self.t_s += dt_s
        self._call(("tick",), lambda: self._tick(f32(dt_s)))
        self._pat_step()
        return self.choices[start:]

    def report_playhead(self, clip, time_s):
        """The renderer's actual clip and its time, at a clip or cycle end, over the modelled ones."""
        p = self._play
        p.active, p.time, p.target = clip, f32(time_s), None

    def playhead(self):
        """The modelled clip, its time and, while it is still blending in, the blend's seconds (else None)."""
        p = self._play
        return (p.target, p.target_time, p.blend_duration) if p.target else (p.active, p.time, None)

    def pool(self, event):
        """The clips and weights a standing `event` draws from, weight > 0 only, as play_event and, for
        `click.single`, play_click_reaction draw them; [] when the pack has no pool for it."""
        p = self.pack
        key = p.event_key(event, "stand")
        if event == "click.single":
            rows = p.events[event].pool if event in p.events else [(c, 1) for c in p.click_reactions or []]
            clips, weights = [c for c, _ in rows], [w if self._open(c) else 0 for c, w in rows]
        elif key is not None:
            clips, weights = self._pool(key, p.events[key].pool)
        else:
            return []
        return [(c, w) for c, w in zip(clips, weights) if w > 0]

    def _stand(self):
        """The seat stand-in ends: the body stands on the clip report_playhead set, and an input kept while
        seated plays now."""
        self._seat = None
        if self.exact_acquisition_pending:
            self.pending = None
        self.exact_owned, self.exact_tier, self.exact_event, self.exact_event_key = False, None, None, None
        pending, self.exact_pending_input = self.exact_pending_input, None
        if pending is None:
            self._builtin()
        elif pending[0] == "intent":
            self.apply_intent(pending[1])
        else:
            self.handle_intent(*pending[1:])

    def _perform(self, i):
        kind = i["kind"]
        if kind == "intent":
            self.handle_intent(i["intent"], i.get("state"), i.get("activity"), i.get("mood"), i.get("display_session"))
        elif kind == "quiet":
            self.clear_intent_presentation()
        elif kind == "text_line":
            if i["on"]:
                self.clause_gestures = False
            self.set_speech_active(i["on"])
        elif kind == "voice":
            self.set_playback_speech(i["on"])
            if i["on"]:
                self.clause_gestures = bool(i.get("clause_gestures"))
        elif kind == "clause":
            if not self._body_busy():
                self.apply_intent(i["intent"])
        elif kind == "clause_end":
            self.retract_gesture(i["intent"])
        elif kind == "semantic":  # agentd hands back the intent its own gestures took, without a clip
            self.semantic = i["intent"]
        elif kind == "click":
            self.play_click_reaction(i.get("region"))
        elif kind == "event":
            self.play_event(i["key"], i.get("waits", True))
        elif kind == "immediate_event":
            self.play_immediate_event(i["key"])
        elif kind == "pat_start":
            if self.play_immediate_event("pat.head") and self.last_event_start:
                self._pat = Pat(self.last_event_start)
        else:
            raise ValueError("unknown motion input kind %s" % kind)

    def _restart(self):
        """A fresh controller on the overview loop, every stream at its seed; its first frame has no length."""
        p = self.pack
        self._play = Playhead(p.overview)
        self._rand = dict(SEEDS)
        self.semantic, self.clock, self.last_event_start, self.waiting_event = "idle", 0.0, None, None
        self.clause_gestures = False
        self.deferred, self.bridging = None, None
        self.intent_held = self.playback_speech = self.speech = False
        self.last_feedback = None
        self.activity, self.activity_start, self.last_intent_key, self.last_intent_start = "idle", None, None, None
        self.session_key = self.session_intent = self.waiting_until = None
        self.requested, self.pending = None, None
        self.held_idle_at = self.exit_boundary = self.activity_mood = None
        self.completing = False
        self.departed_base = self.posture_base = self.posture_event = self.detour_loop = None
        self.exact_owned, self.exact_pending_input, self.exact_event, self.exact_event_key = False, None, None, None
        self.last_click_pool = None
        inf = float("inf")
        self.since_click = self.since_user = inf
        self.idle_clock = self.speech_clock = self.repick_clock = self.next_repick = self.idle_total = 0.0
        self.tier_clock = self.tier_interval = 0.0
        self.exact_tier = self.lifted_tier = None
        self.tier, self.tier_enter, self.tier_last = -1, None, {}
        self.drawn, self.clicks_drawn, self.drawn_at, self.event_at = [], [], {}, {}
        self.starts = []
        self.repicking, self.intent_session = False, None
        self.next_fidget = self._range(p.fidget[1], "fidget")
        self.next_gesture = self._range(p.gestures[1], "gesture") if p.gestures else 0.0
        self._seat, self._pat = None, None
        self._transitions, self._draws, self._remembered = [], {}, {}
        self._before = self._probe()
        self._call(("tick",), lambda: self._tick(0.0))

    # Naming each start.

    def _probe(self):
        return (self._play.active, self._play.target, self.detour_loop)

    def _call(self, kind, body):
        """Runs one host call and names the clips it started: a draw names its clip, also when that clip starts in a
        later call; a start no draw chose is named by the chain, the requested owner or the base it reaches."""
        self._transitions = []
        body()
        if kind[0] == "tick" and not self._transitions:
            return
        before, self._before = self._before, self._probe()
        started = {to for _, to in self._transitions}
        if kind[0] == "seat":
            d = self.deferred
            if d and d.entry and d.clip not in started:
                self._remembered[d.clip] = kind[1:]
        else:
            for clip, tag in self._draws.items():
                # A pick read off a stream without a step leaves no draw to name a later start by.
                if clip not in started and tag[0] != "fidget" and tag[1] != "speech_gestures":
                    self._remembered[clip] = self._resolve(tag, self._play.active)
        draws, self._draws = self._draws, {}
        t_s = round(self.t_s * 1000) / 1000
        for frm, to in self._transitions:
            _, why = self._classify(frm, to, before, kind, draws)
            self.choices.append({"t_s": t_s, "clip": to, "why": why})

    def _tag(self, clip, tag):
        self._draws[clip] = tag

    def _resolve(self, tag, frm):
        p = self.pack
        if tag[0] == "tier":
            return "tier", tag[1] + (" detour from " + self.detour_loop if self.detour_loop else "")
        if tag[0] == "event":
            pool = p.event_key(tag[1], p.posture(frm)) or p.event_key(tag[1], "stand") or tag[1]
            if tag[2]:
                return "repick", pool
            if self.detour_loop:
                return "posture_detour", pool + " in " + self.detour_loop
            return "event", pool
        return tag

    def _classify(self, frm, to, before, kind, draws):
        d, b = self.deferred, self.bridging
        if d and d.entry and d.base == to and d.clip != to:
            return "stage", "base before " + d.clip
        if b and b[0] == to:
            return "bridge", "toward " + b[1]
        if kind[0] == "seat":
            return kind[1:]
        if to in draws:
            self._remembered.pop(to, None)
            return self._resolve(draws[to], frm)
        if to in self._remembered:
            return self._remembered.pop(to)
        return self._fallback(frm, to, before, kind)

    def _fallback(self, frm, clip, before, kind):
        p = self.pack
        active, target, detour = before
        if detour == clip:
            return "chain", "detour back to " + clip
        r = self.requested
        if r and r.start == clip:
            owner = r.owner
            if owner[0] == "activity":
                if owner[1].startswith("idle.t"):
                    return "tier", owner[1]
                return "activity", self._activity_why(owner[1])
            if owner[0] == "session":
                return "event", p.event_key(owner[1], p.posture(frm)) or owner[1]
            if owner[0] == "intent":
                return "intent", "intent." + owner[1] + " primary"
            return "reaction", " ".join(owner)
        for c in [x for x in (frm, target, active) if x is not None]:
            if p.next_clip(c) == clip:
                rule = p.rules.get(c)
                return "chain", ("source return of " if rule and rule.return_clip == clip else "next of ") + c
            if c in p.entries and p.entries[c].exit == clip:
                return "chain", "exit of " + c
        if kind[0] == "input" and kind[1]["kind"] in ("intent", "clause") and self.last_intent_start == clip \
                and self.last_intent_key:
            return "intent", "intent." + self.last_intent_key + " primary"
        bridges = set(p.families.bridges.values()) if p.families else set()
        if clip in bridges:
            return "bridge", "bridge clip"
        if frm in bridges:
            return "bridge", "end of " + frm
        bases = p.idle_bases | {p.relax, p.normal, p.overview, p.from_overview} | (
            p.families.base_clips if p.families else set())
        if clip in bases:
            if kind[0] == "tick" and frm in p.rules and p.rules[frm].return_at is not None:
                return "base", "auto return of " + frm
            return "base", "return to base"
        return "other", "unclassified"

    def _activity_why(self, name):
        return "activity." + name + (" mood " + self.activity_mood if self.activity_mood is not None else "")

    # Random streams.

    def _step(self, stream):
        self._rand[stream] = lcg(self._rand[stream])
        return self._rand[stream]

    def _range(self, r, stream):
        x = self._step(stream)
        return f32(r[0] + f32(f32(f32(r[1] - r[0]) * (x >> 8)) / 16777216))

    def _draw(self, clips, weights, no_repeat, stream, click=False, strict=False):
        """A weighted pick that leaves out the families of the last `no_repeat` picks, and under a budget the last
        one's; it falls back to only the last one's family when that leaves weight (always for strict under a budget),
        else to none. No step when nothing can be drawn."""
        p = self.pack
        history = self.clicks_drawn if click else self.drawn
        last = {p.family(history[-1])} if p.budget and history else set()
        recent = {p.family(c) for c in (history[-no_repeat:] if no_repeat > 0 else [])} | last

        def left(out):
            return sum(w for c, w in zip(clips, weights) if p.family(c) not in out)
        out = recent if left(recent) > 0 else (last if left(last) > 0 or (strict and p.budget) else set())
        total = left(out)
        if total == 0:
            return None
        r = (self._step(stream) >> 8) % total
        for c, w in zip(clips, weights):
            if p.family(c) in out:
                continue
            r -= w
            if r >= 0:
                continue
            history.append(c)
            del history[:-HISTORY]
            self.drawn_at[c] = self.clock
            return c
        return None

    def _pool(self, context, fallback, allowed=None):
        p = self.pack
        ok = lambda c: self._open(c) and (allowed is None or allowed(c))  # noqa: E731
        variants = p.contexts.get(context) or []
        if variants:
            return variants, [p.weight(c, context) if ok(c) else 0 for c in variants]
        return [c for c, _ in fallback], [w if ok(c) else 0 for c, w in fallback]

    # State the rules read.

    @property
    def current(self):
        return self._play.current

    @property
    def posture(self):
        return self.pack.posture(self.current)

    @property
    def speaking(self):
        return self.speech or self.playback_speech

    @property
    def exact_acquisition_pending(self):
        return bool(self.pending) and self.pending[0] == "exact"

    @property
    def preparation_pending(self):
        return self.deferred is not None or self.exact_acquisition_pending

    @property
    def queued_interaction(self):
        return bool(self.pending) and (self.pending[0] == "reaction" or (
            self.pending[0] == "held" and self.pending[2][0] == "interaction"))

    def _body_busy(self):
        return self._seat is not None

    def _enabled(self, clip):
        return clip not in self.pack.disabled

    def _drawable(self, clip):
        return self._enabled(clip) and clip not in self.pack.excluded and clip not in self.pack.absent

    def _open(self, clip):
        return self._drawable(clip) and not self._seated_blocks(clip)

    def _resting(self, clip):
        p = self.pack
        return clip in p.idle_bases or (p.posture(clip) != "stand" and p.loop(clip))

    def _seated_blocks(self, clip):
        p, posture = self.pack, self.posture
        return posture != "stand" and clip in p.stances and p.stances[clip][0] == "stand" and not (
            posture in LIFTED and clip == p.normal)

    def _lifted_posture(self, name):
        p = self.pack
        lists = (p.activities or {}).get(name) if name else None
        for clips in (lists or {}).values():
            for c in clips:
                loop = p.requested_loop(c) if self._enabled(c) else None
                if loop and p.posture(loop) in LIFTED:
                    return p.posture(loop)
        return None

    def _lifted_activity(self, name, key):
        posture = self._lifted_posture(name)
        if posture is None:
            return False
        return key is None or self.pack.event_key(key, posture) is not None or key not in URGENT_EVENTS

    def _busy(self, a, b):
        return self.pack.budget is not None and a in BUSY_EVENTS and b in BUSY_EVENTS

    def _continues_state(self, a, b):
        return a == b or self._busy(a, b)

    def _engaged_base(self):
        p = self.pack
        return p.normal if p.families and self.speaking else p.relax

    def _leaving(self):
        a = self._play
        if self.pack.families and a.target is not None and a.blend_elapsed < f32(a.blend_duration * 0.5):
            return a.active
        return a.current

    def _cooldown_key(self, key):
        return key + "#" + self.intent_session if key in SESSION_COOLDOWNS and self.intent_session else key

    def _budget_allows(self, posture):
        b = self.pack.budget
        if b is None:
            return True
        self.starts = [s for s in self.starts if not f32(self.clock - s) >= 60]
        if posture != "stand":
            return len(self.starts) < b[3]
        if self.semantic != "idle" or self.session_key or self.speaking:
            return len(self.starts) < b[2]
        return len(self.starts) < b[0] and (not self.starts or f32(self.clock - self.starts[-1]) >= b[1])

    def _spend(self):
        if self.pack.budget:
            self.starts.append(self.clock)

    def _set_requested(self, **changes):
        if self.requested:
            for k, v in changes.items():
                setattr(self.requested, k, v)

    # Starting clips.

    def _transition(self, clip, duration, source_duration=False, entry=False, staged_at=None, over_gap=False,
                    start_time=None, keep_staged=False):
        """Starts `clip`. A drawn chain start (`entry`) with pose families first moves to its start family's base and
        waits there; a move to another family's base takes the families' bridge. `keep_staged`: a bridge or source
        return handing over to the base keeps the clip staged there."""
        p, a = self.pack, self._play
        if self._seated_blocks(clip) or a.target == clip or (a.active == clip and a.target is None) or (
                a.active == clip and clip in p.rules and not p.rules[clip].loop):
            self.deferred = None
            return
        frm, f = self._leaving(), p.families
        if entry and f:
            base = staged_at or self._stage_base(clip, f)
            if base and (a.active != base or a.target is not None):
                if (self.bridging[1] if self.bridging else None) != base:
                    self._transition(base, p.crossfade)
                self.deferred = Staged(clip, duration, source_duration, True, base, start_time)
                return
        target, bridge = clip, None
        blend = duration if source_duration else p.blend_in.get(clip, duration)
        if f and (entry or clip in f.base_clips):
            if self.bridging and self.bridging[1] == clip and self.bridging[0] in (a.active, a.target):
                self.deferred = None
                return
            fa, fb = f.family(frm), f.start_family(clip)
            via = f.bridges.get("%s>%s" % (fa, fb)) if fa and fb and fa != fb else None
            if clip in f.base_clips and via:
                target = bridge = via
                blend = p.blend_in.get(via, duration)
            else:
                gap = f.gap_cm(frm, clip)
                if gap is not None and gap > SEAMLESS_CM:
                    blend = max(blend, blend_seconds(gap))
            if frm in p.blend_out:
                blend = max(blend, p.blend_out[frm])
        elif over_gap and f:
            gap = f.gap_cm(frm, clip)
            if gap is not None and gap > SEAMLESS_CM:
                blend = max(blend, blend_seconds(gap))
        d = self.deferred
        if not (keep_staged and d and d.entry and d.base == clip):
            self.deferred = None
        a.transition(target, blend, start_time)
        if frm in p.idle_bases and staged_at is None:
            self.departed_base = frm
        self.bridging = (bridge, clip) if bridge else None
        self._transitions.append((frm, target))

    def _stage_base(self, clip, f):
        if clip not in f.clips:
            return None
        start = f.clips[clip][0]
        base = f.bases.get(start)
        now = f.family(self._leaving())
        if base is None or base == clip or now is None or not (now != start or self.bridging is not None):
            return None
        return base

    def _advance_bridge(self):
        b, a, p = self.bridging, self._play, self.pack
        if not b:
            return
        if b[0] not in (a.active, a.target):
            self.bridging = None
            return
        if a.target is not None or b[0] not in p.lengths:
            return
        length, r = p.lengths[b[0]], p.rules.get(b[0])
        at = f32(r.return_at * length) if r and r.return_at is not None else f32(length - p.crossfade)
        if a.time < at:
            return
        self.bridging = None
        if r and r.return_blend is not None:
            self._transition(b[1], f32(r.return_blend * (1 if r.return_fixed else length)), source_duration=True,
                             keep_staged=True)
        else:
            self._transition(b[1], p.crossfade, keep_staged=True)

    def _builtin(self, duration=0.25, verbatim=False):
        p, a = self.pack, self._play
        self.activity_start = None
        posture = self.posture
        if posture != "stand":
            base = self.posture_base
            if base and base != self.current and p.posture(base) == posture:
                self._transition(base, duration, source_duration=verbatim)
            else:
                self.deferred = None
            return
        if self.semantic == "idle" and not self.speaking:
            if self.current in p.idle_bases:
                self.deferred = None
            else:
                self._transition(self.departed_base or p.normal, duration, source_duration=verbatim)
        elif p.families:
            self._transition(self._engaged_base(), duration, source_duration=verbatim)
        elif a.active == p.overview and a.target is None:
            self._transition(p.from_overview, duration, source_duration=verbatim)
        elif p.from_overview not in (a.active, a.target) and a.active != p.relax:
            self._transition(p.relax, duration, source_duration=verbatim)

    # Requested chains: a held loop, an intent, a reaction or a session event that owns the body until it ends.

    def _clear_requested(self):
        self.requested = self.pending = self.exit_boundary = self.held_idle_at = None
        self.posture_event = self.detour_loop = None

    def _request(self, value):
        self.pending = value
        if self.requested and not self.requested.stopping:
            self.requested.stopping = True
            self.exit_boundary = None
        self._advance_requested()

    def _hold(self, start, owner):
        cur = self.requested
        if cur and cur.owner == owner and not cur.exiting:
            cur.stopping = False
            self.pending = self.exit_boundary = None
            return
        if self.pending and self.pending[0] == "held" and self.pending[2] == owner:
            return
        self._request(("held", start, owner))

    def _safe_exit(self, clip):
        p, a = self.pack, self._play
        if a.target is not None:
            return False
        e = p.entries.get(clip)
        if e is None or e.exit_condition == "immediate" or (e.exit_condition is None and e.interruptible is True):
            return True
        length = p.lengths.get(clip)
        if not length or length <= 0:
            return True
        if not p.loop(clip):
            return a.time >= f32(length - EPS)
        if not self.exit_boundary or self.exit_boundary[0] != clip:
            cycle = float(math.floor(f32(a.time / length)))
            at_boundary = a.time > 0 and abs(f32(a.time - f32(cycle * length))) < EPS
            self.exit_boundary = (clip, a.time if at_boundary else f32(f32(cycle + 1) * length))
        return a.time >= f32(self.exit_boundary[1] - EPS)

    def _finish_requested(self):
        self.requested = self.exit_boundary = self.activity_start = self.held_idle_at = None
        self.posture_event = self.detour_loop = None
        pending, self.pending = self.pending, None
        self.completing = True
        try:
            if pending:
                self._perform_request(pending)
            else:
                self._builtin()
        finally:
            self.completing = False

    def _perform_request(self, value):
        kind, p = value[0], self.pack
        if kind == "held":
            _, start, owner = value
            if not (self._open(start) or (owner == ("interaction", start) and not self._seated_blocks(start)
                                          and start not in p.excluded)):
                return
            self._transition(start, p.crossfade, entry=True)
            self.requested = Requested(start, owner)
            self.held_idle_at = None
            self.intent_held = False
            self.activity_start = start if owner[0] == "activity" else None
        elif kind == "intent":
            self.apply_intent(value[1])
        elif kind == "reaction":
            self.play_reaction(value[1])
        elif kind == "event":
            self.play_event(value[1])
        elif kind == "exact":
            self._start_exact(value[1], value[2], value[3], acquiring=True)
        elif kind == "semantic":
            self.handle_intent(*value[1:])
        elif kind == "builtin":
            self._builtin()
        elif kind == "repick":
            self.repicking = True
            try:
                self.play_event(value[1])
            finally:
                self.repicking = False

    def _advance_requested(self):
        """True while a requested chain owns policy advancement."""
        p, a = self.pack, self._play
        if self.requested is None and self.pending is None:
            return False
        if self._body_busy() and not self.exact_acquisition_pending:
            return True
        if self.requested is None:
            if not (a.target is None and self._safe_exit(a.active) and self.pending is not None):
                return True
            pending, self.pending, self.exit_boundary = self.pending, None, None
            self._perform_request(pending)
            return True
        held = self.requested
        if held.stopping and not held.exiting and self.detour_loop is None and self.current not in p.chain(held.start):
            self.deferred = None
            self._finish_requested()
            return True
        if a.target is not None or self.deferred is not None:
            return True
        clip = a.active
        e, loop = p.entries.get(clip), p.loop(clip)
        if held.exiting:
            if loop or a.time >= f32(p.lengths.get(clip, 0.0) - EPS):
                if not loop and e and e.next:
                    self._transition(e.next, p.crossfade, over_gap=True)
                else:
                    self._finish_requested()
            return True
        if held.stopping and e and e.held:
            if not self._safe_exit(clip):
                return True
            posture = self.posture
            # A session loop hands over to an air or boss take-off at its cycle edge, without its exit.
            if held.owner[0] == "session" and self.pending and self.pending[0] == "held" \
                    and self.pending[2][0] == "activity" and self._lifted_posture(self.pending[2][1]):
                self._finish_requested()
            elif e.exit:
                self._set_requested(exiting=True)
                self.exit_boundary = None
                self._transition(e.exit, p.crossfade, over_gap=True)
            elif posture in LIFTED:
                self._set_requested(exiting=True)
                self.exit_boundary = None
                self._transition(p.normal, p.blend_out.get(clip, p.crossfade), source_duration=True)
            else:
                self._finish_requested()
            return True
        if held.stopping and e and e.exit and self._safe_exit(clip):
            self._set_requested(exiting=True)
            self.exit_boundary = None
            self._transition(e.exit, p.crossfade, over_gap=True)
            return True
        if e and e.held:
            self._advance_held(held, clip, e)
            return True
        done = (e is not None and e.hold_seconds is not None and a.time >= e.hold_seconds) if loop \
            else a.time >= f32(p.lengths.get(clip, 0.0) - EPS)
        if done:
            if e and e.next:
                self._transition(e.next, p.crossfade, over_gap=True)
            elif self.detour_loop:
                back, self.detour_loop = self.detour_loop, None
                self._transition(back, self._detour_blend(back, clip), source_duration=True)
            else:
                self._finish_requested()
        return True

    def _advance_held(self, held, clip, e):
        """A held loop: a posture event's detour, a lifted posture's tier detour, an idle variant, or a session
        loop's repick past its gap."""
        p = self.pack
        if self.posture_event and not held.stopping:
            if self._safe_exit(clip):
                key, self.posture_event, self.exit_boundary = self.posture_event, None, None
                self._detour(key, clip)
            return
        if held.owner[0] == "activity" and not held.stopping and self.lifted_tier is not None \
                and self._budget_allows(self.posture) and self._safe_exit(clip):
            posture, i = self.posture, self.lifted_tier
            self.lifted_tier = self.exit_boundary = None
            pick = self._draw_tier(i, self._posture_only(posture))
            if pick:
                self._tag(pick, ("tier", "idle.t%d" % (i + 1)))
                self._spend()
                self.detour_loop, self.held_idle_at = clip, None
                self._transition(pick, self._detour_blend(clip, pick), source_duration=True)
            return
        if held.owner[0] == "activity" and not held.stopping and not self.speaking and e.idle_variants \
                and e.idle_interval_s:
            if self.held_idle_at is None:
                self.held_idle_at = f32(self.clock + self._range(e.idle_interval_s, "tier"))
            if self.clock >= self.held_idle_at and self._budget_allows(self.posture) and self._safe_exit(clip):
                available = [v for v in e.idle_variants if self._open(v)]
                pick = self._draw(available, [p.weight(v, "activity.relax") for v in available], 1, "tier",
                                  strict=True)
                if pick:
                    loop = next(c for c in sorted(p.entries) if pick in (p.entries[c].idle_variants or []))
                    self._tag(pick, ("held_variant", "idle_variants of " + loop))
                    self.requested = Requested(pick, held.owner)
                    self.exit_boundary = self.held_idle_at = None
                    self._spend()
                    self._transition(pick, p.crossfade)
                else:
                    self.held_idle_at = f32(self.clock + self._range(e.idle_interval_s, "tier"))
        if held.owner[0] == "session" and p.budget and not held.stopping and not self.speaking and e.exit:
            key = self.session_key or held.owner[1]
            gap = self._repick_gap(key)
            if self._continues_state(held.owner[1], key) and gap:
                if self.held_idle_at is None:
                    self.held_idle_at = f32(self.clock + self._range(gap, "event"))
                if self.clock >= self.held_idle_at and self._budget_allows(self.posture) and self._safe_exit(clip):
                    self.held_idle_at = None
                    self.pending = ("repick", key)
                    self._set_requested(stopping=True, exiting=True)
                    self.exit_boundary = None
                    self._transition(e.exit, p.crossfade, over_gap=True)

    def _posture_only(self, posture):
        p = self.pack
        return lambda c: p.requested_loop(c) is None and c in p.stances and p.stances[c][0] == posture \
            and p.posture(c) == posture

    def _detour(self, key, loop):
        pick = self._draw_posture(key, loop, loops=True)
        if not pick:
            return
        self._tag(pick, ("event", key, self.repicking))
        self.detour_loop, self.held_idle_at = loop, None
        self._transition(pick, self._detour_blend(loop, pick), source_duration=True)
        self.event_at[self._cooldown_key(key)] = self.clock
        self.last_event_start = pick

    def _detour_blend(self, loop, clip):
        p = self.pack
        gap = p.families.redraw_gap_cm(loop, clip) if p.families else None
        return max(p.blend_in.get(clip, p.crossfade), blend_seconds(gap) if gap is not None else 0.0)

    def _draw_posture(self, key, loop, loops):
        p = self.pack
        pool_key = p.event_key(key, p.posture(loop))
        if pool_key is None:
            return None
        e = p.events[pool_key]
        clips, weights = self._pool(pool_key, e.pool)
        weights = [w if p.requested_loop(c) is None and (loops or not p.loop(c)) else 0 for c, w in zip(clips, weights)]
        return self._draw(clips, weights, 2 if e.no_repeat is None else e.no_repeat, "event")

    # Exact owners (the seat).

    def acquire_exact(self, clip, blend=0.25, verbatim=False):
        if clip not in self.pack.rules:
            return False
        if self.exact_owned:
            return self._start_exact(clip, blend, verbatim, acquiring=False)
        if self.pending and self.pending[0] == "exact" and self.pending[1] == clip:
            return True
        if self._seated_blocks(clip) and not self._stance_allows_preparation(clip):
            return False
        self._request(("exact", clip, blend, verbatim))
        return True

    def _stance_allows_preparation(self, clip):
        p = self.pack
        if not self._seated_blocks(clip):
            return True
        loop = p.requested_loop(self.requested.start) if self.requested else None
        exit = p.entries[loop].exit if loop else None
        last = p.chain(exit)[-1] if exit else None
        return last is not None and last in p.stances and p.stances[last][1] == "stand"

    def _start_exact(self, clip, blend, verbatim, acquiring):
        p = self.pack
        if clip not in p.rules or self._seated_blocks(clip):
            return False
        if self.deferred and self.deferred.clip == clip and self.deferred.entry:
            return True
        staged = acquiring and p.families is not None and self._stage_base(clip, p.families) is not None
        self._transition(clip, blend, source_duration=verbatim, entry=staged)
        self._clear_requested()
        self.activity_start, self.intent_held, self.exact_owned = None, False, True
        return True

    def tier_pick(self, loop):
        """For an exact owner holding `loop`: a clip of the idle tier due for its posture that starts and ends in it,
        with its length and loop flag; nil while none is due. It plays nothing itself."""
        p = self.pack
        posture = p.posture(loop)
        i = self.exact_tier
        if not self.exact_owned or self.exact_event_key is not None or posture == "stand" or i is None \
                or p.tier_postures[i] != posture or not self._budget_allows(posture):
            return None
        self.exact_tier = None
        pick = self._draw_tier(i, self._posture_only(posture))
        if pick is None:
            return None
        self._spend()
        return pick, p.lengths[pick], p.loop(pick)

    def _seat_step(self):
        """HostSeat's sit.seat use: enter, loop, and at each loop boundary the due seated tier's clip as a detour."""
        s = self._seat
        if s is None or self.preparation_pending:
            return
        p, a = self.pack, self._play
        clip, t = a.active, a.time
        loop_again = lambda: self._call(("seat", "seat", "loop " + s.id),  # noqa: E731
                                        lambda: self.acquire_exact(s.loop, SEAT_BLEND))
        if not s.seated:
            if clip == s.enter and t >= f32(p.lengths[s.enter] - SEAT_BLEND):
                loop_again()
            elif clip == s.loop:
                s.seated = True
            return
        if s.detour:
            if clip == s.loop and a.target is None:
                s.detour = None
            else:
                if clip == s.detour[0] and a.target is None and t >= f32(s.detour[1] - SEAT_BLEND):
                    loop_again()
                return
        if not (clip == s.loop and a.target is None):
            s.boundary = None
            return
        length = p.lengths[s.loop]
        at = s.boundary if s.boundary is not None else f32(
            f32(float(math.floor(f32(f32(t + SEAT_BLEND) / length))) + 1) * length)
        s.boundary = at
        if t < f32(at - SEAT_BLEND):
            return
        s.boundary = None
        due = self.exact_tier
        pick = self.tier_pick(s.loop)
        if pick is None:
            return
        clip, length, loops = pick
        s.detour = (clip, f32(length * max(1.0, float(math.ceil(f32(SEAT_HOLD_S / length))))) if loops else length)
        why = "idle.t%d seat tierPick" % ((due + 1) if due is not None else 0)
        self._call(("seat", "tier", why), lambda: self.acquire_exact(clip, SEAT_BLEND))

    def _pat_step(self):
        """HostReactions for the pat chain: once asked, it leaves the chain's loop through leave_event."""
        c = self._pat
        if c is None:
            return
        p = self.pack
        clip = self.current
        if clip not in p.chain(c.start):
            if c.entered:
                self._pat = None
            return
        c.entered = True
        if not c.left and p.loop(clip) and clip in p.entries and p.entries[clip].exit and c.leave:
            owner = c.start if p.requested_loop(c.start) else clip
            self._call(("host",), lambda: setattr(c, "left", self.leave_event(owner)))

    # Intents, speech and activities.

    def apply_intent(self, intent):
        p = self.pack
        if intent == "none":
            return True
        if intent not in INTENTS:
            return False
        if self.exact_owned or self.exact_acquisition_pending:
            self.semantic, self.exact_pending_input = intent, ("intent", intent)
            self.exact_event = self.exact_event_key = None
            return True
        if self.queued_interaction and intent == self.semantic:
            return True
        r = self.requested
        if r and r.owner[0] == "interaction" and not r.stopping and intent == self.semantic:
            return True
        start = p.primary(intent)
        if start and self._enabled(start) and p.requested_loop(start):
            self.semantic = intent
            self._hold(start, ("intent", intent))
            return True
        if self.requested or self.pending:
            self.semantic = intent
            self._request(("intent", intent))
            return True
        if not self.completing and intent == self.semantic and self.current in p.entries:
            return True
        self.semantic = intent
        if self._body_busy():
            self.intent_held = True
            return True
        if not self._mapped_intent(intent):
            self._builtin()
        return True

    def _mapped_intent(self, intent):
        p = self.pack
        current, start = self.current, p.primary(intent)
        candidates = p.contexts.get("intent." + intent)
        if not self.clause_gestures and candidates:
            if self.last_intent_key == intent and current in p.chain(self.last_intent_start):
                return True
            context = "intent." + intent
            start = self._draw(candidates, [p.weight(c, context) if self._open(c) else 0 for c in candidates], 3,
                               "activity")
            if start:
                self._tag(start, ("intent", context))
        if start and not self._enabled(start):
            start = None
        self.last_intent_key, self.last_intent_start = intent, start
        if start:
            if current in p.chain(start):
                return True
            self.activity_start = None
            self._transition(start, p.crossfade, entry=True)
            return True
        if self.completing:
            return False
        entry = p.entries.get(current)
        if intent == "speak" and entry and current in p.chain(self.activity_start):
            self.activity_start = None
            self._transition(entry.exit or self._engaged_base(), p.crossfade, over_gap=True)
            return True
        if entry is None or entry.interruptible is True:
            return False
        if entry.exit:
            self._transition(entry.exit, p.crossfade, over_gap=True)
        return True

    def retract_gesture(self, intent):
        p = self.pack
        if self.exact_owned or self.exact_acquisition_pending:
            return
        if self.requested and self.requested.owner == ("intent", intent):
            self._request(("builtin",))
            return
        start = self.last_intent_start if self.last_intent_key == intent else p.primary(intent)
        if self.current in p.chain(start):
            self.activity_start = None
            self._builtin()

    def set_playback_speech(self, on):
        if self.playback_speech == on:
            return
        self.playback_speech = on
        self._feedback()

    def set_speech_active(self, on):
        self.speech = on
        self._feedback()

    def _feedback(self):
        intent = "speak" if self.speaking else "idle"
        if intent == self.last_feedback and self.current in self.pack.entries:
            return
        self.last_feedback = intent
        self.apply_intent(intent)

    def handle_intent(self, intent, state=None, activity=None, mood=None, display_session=None):
        p = self.pack
        if activity and (p.activities is None or activity not in p.activities):
            activity = ACTIVITY_STAND_INS.get(activity, activity)
        self.intent_session = display_session
        event = SESSION_EVENTS.get(state or "")
        if (self.exact_owned or self.exact_acquisition_pending) and intent in INTENTS:
            self.semantic = intent
            self.exact_pending_input = ("semantic", intent, state, activity, mood, display_session)
            key = event if event in p.event_names else None
            if key != self.exact_event_key:
                if not self._busy(key, self.exact_event_key) or self.exact_event is not None:
                    self.exact_event = key
                self.exact_event_key = key
            return True
        key = event if event in p.event_names and intent in INTENTS else None
        current = p.entries.get(self.current)
        takes_off = self._lifted_posture(activity) is not None and current is not None and current.held
        r = self.requested
        if key and r and r.owner[0] == "session" and self._continues_state(r.owner[1], key):
            if not r.stopping and not takes_off:
                self._hold_session(intent, key, mood)
                return True
            if self.pending and self.pending[0] == "repick" and self._continues_state(self.pending[1], key):
                self.pending = ("repick", key)
                self._hold_session(intent, key, mood)
                return True
        if key is None and intent == self.semantic and (activity or "idle") == self.activity and (
                self.queued_interaction or (r and r.owner[0] == "interaction" and not r.stopping)):
            self.activity_mood = mood
            return True
        lifted_hold = self._lifted_activity(activity, key)
        if intent in INTENTS and (key is None or lifted_hold) and self._requested_activity(intent, activity, mood):
            if self.waiting_event and self.waiting_event == self.session_key \
                    and self.waiting_event not in ONE_SHOT_SESSIONS:
                self._clear_waiting()
            previous = self.session_key
            self.session_key = key if lifted_hold else None
            self.semantic = intent
            if lifted_hold and key and key != previous and self.posture in LIFTED:
                self.session_intent = intent
                self.play_event(key)
            return True
        # A held posture keeps its owner unless the event is urgent and has no pool there.
        posture, r = self.posture, self.requested
        if key and r and not r.stopping and posture != "stand" and posture not in LIFTED and (
                p.event_key(key, posture) is not None or key not in URGENT_EVENTS):
            self._hold_session(intent, key, mood)
            self.intent_held = False
            self.play_event(key)
            return True
        if (self.requested or self.pending) and intent in INTENTS:
            self.semantic = intent
            self._request(("semantic", intent, state, activity, mood, display_session))
            return True
        # A change within the busy state keeps the chain, or the wait for its next draw, and draws from the new pool.
        flip = key != self.session_key and self._busy(key, self.session_key)
        waits = flip and self.session_key is not None and self._repick_gap(self.session_key) is not None \
            and key is not None and self._repick_gap(key) is not None
        if flip and self.waiting_event == self.session_key:
            self.waiting_event = key
        if key != self.session_key and self.waiting_event and self.waiting_event == self.session_key \
                and self.waiting_event not in ONE_SHOT_SESSIONS:
            self._clear_waiting()
        if key is None:
            self.session_key = None
            ok = self.apply_intent(intent)
        else:
            same = flip or (key == self.session_key and intent == self.semantic)
            self.semantic = self.session_intent = intent
            self.intent_held = False
            self.session_key = key
            if not waits:
                self._next_repick_time()
            if not (same and (waits or self.current in p.chain(self.last_event_start))):
                played = self.play_event(key)
                if not played and self.waiting_event != key and self.current not in p.entries:
                    self._builtin()
            ok = True
        if ok:
            self._apply_activity(intent, activity, mood, key is not None)
        return ok

    def _hold_session(self, intent, key, mood):
        self.semantic, self.session_key, self.session_intent, self.activity_mood = intent, key, intent, mood

    def _requested_activity(self, intent, name, mood):
        """A sustained activity: a chain with a held loop that plays until another intent or activity."""
        p = self.pack
        if self.speaking or name is None or name not in (p.activities or {}):
            return False
        lists = p.activities[name]
        owner = ("activity", name, intent)
        held_owner = self.requested.owner if self.requested else (
            self.pending[2] if self.pending and self.pending[0] == "held" else None)
        # An air or boss activity keeps its hold across intents.
        if self._lifted_posture(name) and held_owner and held_owner[0] == "activity" and held_owner[1] == name:
            owner = ("activity", name, held_owner[2])
        if (self.requested and self.requested.owner == owner) or (
                self.pending and self.pending[0] == "held" and self.pending[2] == owner):
            self.activity, self.activity_mood = name, mood
            if self.requested:
                self._hold(self.requested.start, owner)
            return True
        context = "activity." + name
        listed = lists[mood or ""] if (mood or "") in lists else lists.get("*", [])
        explicit = [c for c in listed if self._enabled(c) and p.requested_loop(c)]
        variants = [c for c in p.contexts.get(context, []) if self._enabled(c) and p.requested_loop(c)]
        candidates = explicit or variants
        if not candidates:
            return False
        weights = [1] * len(candidates) if explicit else [p.weight(c, context, mood) for c in candidates]
        start = self._draw(candidates, weights, 2 if explicit else 3, "activity")
        if start is None:
            return False
        self.activity, self.activity_mood = name, mood
        self._tag(start, ("activity", self._activity_why(name)))
        self._hold(start, owner)
        return True

    def _apply_activity(self, intent, name, mood, routed):
        """A one-shot activity: one chain that ends at the base."""
        p = self.pack
        a = name if name in ONE_SHOT_ACTIVITIES or name in (p.activities or {}) else "idle"
        if a == self.activity:
            return
        self.activity = a
        if self._body_busy():
            return
        lists = (p.activities or {}).get(a)
        if lists is None or self.speaking or routed or p.primary(intent) is not None:
            return
        current = p.entries.get(self.current)
        if not self.completing and current and current.interruptible is not True:
            return
        context = "activity." + a
        variants = p.contexts.get(context) or []
        if variants:
            pick = [c for c in variants if self._open(c)]
            weights = [p.weight(c, context, mood) for c in pick]
            no_repeat = 3
        else:
            listed = lists[mood or ""] if (mood or "") in lists else lists.get("*", [])
            pick = [c for c in listed if self._enabled(c)]
            weights = [1] * len(pick)
            no_repeat = 2 if p.events or p.tiers is not None else 0
        if not pick:
            return
        self.activity_start = self._draw(pick, weights, no_repeat, "activity")
        if self.activity_start:
            self._tag(self.activity_start, ("activity", self._activity_why(a)))
            self._spend()
            self._transition(self.activity_start, p.crossfade, entry=True)

    def clear_intent_presentation(self):
        p = self.pack
        if self.waiting_event and self.waiting_event.startswith("session."):
            self._clear_waiting()
        self.session_key = self.session_intent = self.activity_start = None
        self.activity = "idle"
        intent = "speak" if self.speaking else "idle"
        if self.exact_owned or self.exact_acquisition_pending or self.requested or self.pending:
            self.intent_held = False
            self.apply_intent(intent)
            return
        self.semantic = intent
        self.intent_held = self._body_busy()
        if self.intent_held:
            return
        e = p.entries.get(self.current)
        if e and e.interruptible is not True:
            if e.exit:
                self._transition(e.exit, p.crossfade, over_gap=True)
            return
        self.deferred = None
        self._builtin()

    # Events and reactions.

    def _clear_waiting(self):
        self.waiting_event = self.waiting_until = None

    def play_immediate_event(self, key):
        if self.exact_owned or self.exact_acquisition_pending or self.requested or self.pending:
            return False
        return self._start_event(key) is None

    def play_event(self, key, waits=True):
        p = self.pack
        if self.exact_owned or self.exact_acquisition_pending:
            return False
        posture = self.posture
        known = key in p.event_names
        if posture != "stand" and known:
            if p.event_key(key, posture) is not None:
                r = self.requested
                loop = p.requested_loop(r.start) if r else None
                if r and not r.stopping and self.pending is None and loop and p.posture(loop) == posture:
                    self.posture_event = key
                    return True
            else:
                # Without a pool here only an urgent event leaves, through the posture's exit.
                if not (waits and key in URGENT_EVENTS and p.event_key(key, "stand") is not None):
                    return False
                if self.requested is None and self.pending is None:
                    e = p.entries.get(self.current)
                    if not (e and e.exit) or p.posture((p.chain(e.exit) or [e.exit])[-1]) != "stand":
                        return False
                    self.requested = Requested(self.current, ("session", key))
                self._request(("event", key))
                return True
        if (self.requested or self.pending) and known:
            if not waits and not self._leaves_session(key):
                return False
            self._request(("event", key))
            return True
        r = self._start_event(key)
        if r == "waiting":
            if waits:
                if self.waiting_event != key:
                    self.waiting_until = f32(self.clock + 60)
                self.waiting_event = key
        elif self.waiting_event == key:
            self._clear_waiting()
        return r is None

    def _leaves_session(self, key):
        p, r = self.pack, self.requested
        if not (r and r.owner[0] == "session" and not r.stopping and self.pending is None):
            return False
        pool_key = p.event_key(key, "stand")
        return pool_key is not None and p.events[pool_key].interrupt == "user"

    def _start_event(self, key):
        p, a = self.pack, self._play
        if key not in p.event_names:
            return "unknown"
        posture = self.posture
        pool_key = p.event_key(key, posture)
        if pool_key is None:
            return "posture"
        e = p.events[pool_key]
        level = e.interrupt
        at = self.event_at.get(self._cooldown_key(key))
        if not self.repicking and at is not None and f32(self.clock - at) < e.cooldown_s:
            return "cooldown"
        if self.playback_speech if level == "user" else self.speaking:
            return "waiting" if key.startswith("session.") else "speaking"
        # A repick follows the exit its held loop has just finished.
        entry = None if self.repicking else p.entries.get(self.current)
        if level != "user" and (self._body_busy() or (level == "high" and self.since_user < 1.5) or (
                level == "mid" and entry is not None and entry.interruptible is not True) or (
                level == "low" and (a.target is not None or not self._resting(a.active) or self.semantic != "idle"))
                or not self._budget_allows(posture)):
            return "waiting"
        clips, weights = self._pool(pool_key, e.pool)
        pick = self._draw(clips, weights, 2 if e.no_repeat is None else e.no_repeat, "event", strict=self.repicking)
        if pick is None:
            return "empty"
        self._tag(pick, ("event", key, self.repicking))
        if level != "user":
            self._spend()
        if posture != "stand" and self._resting(self.current):
            self.posture_base = self.current
        if p.requested_loop(pick):
            self._hold(pick, ("session", key))
        else:
            self._transition(pick, p.crossfade, entry=True)
        self.event_at[self._cooldown_key(key)] = self.clock
        if level == "user":
            self.since_user = 0.0
        self.activity_start = None
        self.last_event_start = pick
        return None

    def _repick_gap(self, key, posture=None):
        p = self.pack
        pool_key = p.event_key(key, posture or self.posture)
        return p.events[pool_key].repick_gap_s if pool_key else None

    def _next_repick_time(self):
        self.repick_clock = 0.0
        gap = self._repick_gap(self.session_key) if self.session_key else None
        if gap:
            self.next_repick = self._range(gap, "event")

    def play_reaction(self, clip):
        p = self.pack
        if self.exact_owned or self.exact_acquisition_pending or self.speaking or clip not in p.entries:
            return False
        if p.requested_loop(clip):
            self._hold(clip, ("interaction", clip))
            return True
        if self.requested or self.pending:
            self._request(("reaction", clip))
            return True
        current = p.entries.get(self.current)
        retained = self.current != clip and current is not None and current.complete_on_enter is True
        if not retained and self.current in p.chain(clip) and self.current != p.entries[clip].exit:
            return True
        self.activity_start = None
        self._transition(clip, p.crossfade, entry=True)
        return True

    def leave_event(self, start):
        """Leaves the chain `start` began through its exit, else to relax."""
        p = self.pack
        if self.exact_owned or self.exact_acquisition_pending or self.speaking or start not in p.entries:
            return False
        if self.requested and self.requested.start == start:
            self._request(("builtin",))
            return True
        self.activity_start = None
        self._transition(p.entries[start].exit or p.relax, p.crossfade, over_gap=True)
        return True

    def play_click_reaction(self, region=None):
        p = self.pack
        posture = self.posture
        keys = ["click." + region] + REGION_KEYS.get(region, []) if region else []
        region_pool = next((k for k in (p.event_key(k, posture) for k in keys) if k), None)
        pool_key = region_pool or ("click.single" if "click.single" in p.events else "click_reactions")
        if region_pool:
            rows = p.events[region_pool].pool
        elif "click.single" in p.events:
            rows = p.events["click.single"].pool
        else:
            rows = [(c, 1) for c in p.click_reactions or []]
        if self.exact_owned or self.exact_acquisition_pending or not rows or self.since_click < 1.5 \
                or self.playback_speech:
            return False
        c = self._draw([c for c, _ in rows], [w if self._open(c) else 0 for c, w in rows], 1, "click", click=True)
        if c is None:
            return False
        self.last_click_pool = pool_key
        self._tag(c, ("click", "%s region %s" % (pool_key, region or "none")))
        if self.requested or self.pending:
            self._request(("reaction", c))
        else:
            self._transition(c, p.crossfade, entry=True)
            self.activity_start = None
        self.since_click = self.since_user = 0.0
        return True

    # The frame.

    def _tick(self, dt):
        p, a = self.pack, self._play
        d = self.deferred
        if d and (self.requested is None or not self._body_busy() or self.exact_acquisition_pending):
            self._transition(d.clip, d.duration, source_duration=d.source_duration, entry=d.entry, staged_at=d.base,
                             start_time=d.start_time)
        dt = a.advance(dt)
        self.clock = f32(self.clock + dt)
        self.since_click = f32(self.since_click + dt)
        self.since_user = f32(self.since_user + dt)
        if self.exact_owned:
            self.exact_tier = self._due_tier(dt)
            return
        if self.requested:
            self.lifted_tier = self._due_tier(dt) if self.posture in LIFTED else None
        self._advance_bridge()
        if self._advance_requested():
            return
        if self.intent_held and not self._body_busy():
            self.intent_held = False
            if not self._mapped_intent(self.semantic):
                self._builtin()
        self._advance_events(dt)
        self._advance_tiers(dt)
        self._advance_mapped(dt)
        e, r = p.entries.get(a.active), p.rules.get(a.active)
        if not (self._body_busy() and e and e.held) and a.target is None and r and r.return_at is not None \
                and a.time >= f32(p.lengths[a.active] * r.return_at):
            duration = f32((r.return_blend or 0.0) * (1 if r.return_fixed else p.lengths[a.active]))
            if r.return_clip:
                destination = r.return_clip
            elif p.tiers is not None and self.semantic == "idle" and not self.speaking:
                destination = self.departed_base or p.normal
            else:
                destination = self._engaged_base()
            self._transition(destination, duration, source_duration=r.return_clip is not None, keep_staged=True)

    def _advance_events(self, dt):
        a = self._play
        if self.waiting_until is not None and self.clock >= self.waiting_until:
            self._clear_waiting()
        if self.waiting_event and a.target is None and self._start_event(self.waiting_event) != "waiting":
            self._clear_waiting()
        key = self.session_key
        if not (key and self.semantic == self.session_intent and self._repick_gap(key) is not None
                and self.waiting_event is None and a.target is None and a.active not in self.pack.entries
                and not self.speaking):
            self.repick_clock = 0.0
            return
        self.repick_clock = f32(self.repick_clock + dt)
        if self.repick_clock >= self.next_repick:
            self._next_repick_time()
            self.play_event(key)

    def _due_tier(self, dt):
        """Advances the idle tier clocks; the tier due now, None while none is."""
        p, a = self.pack, self._play
        if p.tiers is None:
            return None
        current, posture = self.current, self.posture

        def rest(clip):
            return clip in p.idle_bases or (posture != "stand" and posture in p.tier_postures and self._resting(clip))
        bridge = p.families is not None and current in p.families.bridges.values()
        if self.semantic != "idle" or self.speaking or (not rest(current) and current not in (p.relax, p.from_overview)
                                                        and current not in p.tier_clips and not bridge):
            self.idle_total = self.tier_clock = 0.0
            self.tier, self.tier_enter = -1, None
            return None
        if self.tier_enter is None:
            self.tier_enter = [self._range(t.after_s, "tier") for t in p.tiers]
        self.idle_total = f32(self.idle_total + dt)
        if a.target is not None or not rest(a.active):
            self.tier_clock = 0.0
            return None
        self.tier_clock = f32(self.tier_clock + dt)
        reached = -1
        for i, enter in enumerate(self.tier_enter):
            if self.idle_total >= enter and p.tier_postures[i] == posture:
                reached = i
        if reached < 0 or (reached == self.tier and self.tier_clock < self.tier_interval):
            return None
        return reached

    def _draw_tier(self, i, allowed=None):
        """Restarts tier i's interval and draws from its pool. With pose families a clip starting in the family she
        is in comes first, unless all of those were drawn within no_repeat."""
        p = self.pack
        self.tier = i
        t = p.tiers[i]
        cooldown = t.after_s[0]
        self.tier_interval = self._range(t.interval_s or t.after_s, "tier")
        self.tier_clock = 0.0

        def ok(c):
            at = self.drawn_at.get(c)
            return (allowed is None or allowed(c)) and not (
                c in t.min_gap_s and at is not None and f32(self.clock - at) < t.min_gap_s[c]) and not (
                at is not None and f32(self.clock - at) < cooldown)
        clips, weights = self._pool("idle.t%d" % (i + 1), t.pool, ok)
        if len(clips) > 1 and i in self.tier_last:
            weights = [0 if c == self.tier_last[i] else w for c, w in zip(clips, weights)]
        no_repeat = 2 if t.no_repeat is None else t.no_repeat
        f = p.families
        now = f.family(self._leaving()) if f else None
        if now is not None:
            recent = {p.family(c) for c in self.drawn[-max(1, no_repeat):]}
            same = [w if (f.start_family(c) == now or (p.library.get(c) or {}).get("unbridged"))
                    and p.family(c) not in recent else 0 for c, w in zip(clips, weights)]
            if any(w > 0 for w in same):
                weights = same
        pick = self._draw(clips, weights, no_repeat, "tier", strict=True)
        if pick:
            self.tier_last[i] = pick
        return pick

    def _advance_tiers(self, dt):
        p = self.pack
        current, posture = self.current, self.posture
        i = self._due_tier(dt)
        if i is None or not self._budget_allows(posture):
            return
        pick = self._draw_tier(i)
        if pick is None:
            return
        self._tag(pick, ("tier", "idle.t%d" % (i + 1)))
        self.activity_start = None
        self._spend()
        if posture != "stand" and self._resting(current):
            self.posture_base = current
        if p.requested_loop(pick):
            self._hold(pick, ("activity", "idle.t%d" % (i + 1), self.semantic))
        else:
            self._transition(pick, p.crossfade, entry=True)

    def _advance_mapped(self, dt):
        """A mapped clip's end or next, then speech gestures while speaking, and fidgets in a pack without tiers."""
        p, a = self.pack, self._play
        if a.target is not None:
            return
        clip = a.active
        if clip in p.rules and p.rules[clip].return_clip:
            return
        # With pose families overview is a pose chains pass through, not a resting base.
        if self.deferred is None and p.families and clip in p.families.base_clips and clip not in p.idle_bases:
            self._builtin()
            return
        e = p.entries.get(clip)
        if e and e.held and self._body_busy():
            return
        if e:
            if p.loop(clip):
                done = e.hold_seconds is not None and a.time >= e.hold_seconds
            else:
                done = a.time >= f32(p.lengths[clip] - (EPS if e.end_at_length is True else p.crossfade))
            if done:
                if e.next:
                    self._transition(e.next, p.crossfade, over_gap=True)
                else:
                    self._builtin()
            if e.complete_on_enter is not True:
                return
        variants = p.contexts.get("speech.gesture") or []
        gestures = variants or [c for c in (p.gestures[0] if p.gestures else []) if self._drawable(c)]
        if self.speaking and not self.clause_gestures and clip == self._engaged_base() and gestures:
            self.speech_clock = f32(self.speech_clock + dt)
            if self.speech_clock >= self.next_gesture:
                if variants:
                    pick = self._draw(gestures, [p.weight(c, "speech.gesture") if self._open(c) else 0
                                                 for c in gestures], 3, "gesture")
                    why = "speech.gesture"
                else:
                    # A pick outside the library reads the stream without stepping it.
                    pick = gestures[(self._rand["gesture"] >> 8) % len(gestures)]
                    why = "speech_gestures"
                if pick:
                    self._tag(pick, ("speech_gesture", why))
                    self._transition(pick, p.crossfade, entry=True)
                self.speech_clock = 0.0
                if p.gestures:
                    self.next_gesture = self._range(p.gestures[1], "gesture")
        elif not self.speaking:
            self.speech_clock = 0.0
        if clip not in p.idle_bases or self.semantic != "idle" or self.speaking or p.tiers is not None:
            self.idle_clock = 0.0
            return
        self.idle_clock = f32(self.idle_clock + dt)
        if self.idle_clock < self.next_fidget:
            return
        fidgets = [c for c in p.fidget[0] if self._drawable(c)]
        if fidgets:
            # The fidget pick reads the stream without stepping it.
            pick = fidgets[self._rand["fidget"] % len(fidgets)]
            self._tag(pick, ("fidget", "idle_fidget"))
            self._transition(pick, p.crossfade, entry=True)
        self.idle_clock = 0.0
        self.next_fidget = self._range(p.fidget[1], "fidget")
