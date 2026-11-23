#!/usr/bin/env python3
"""Replays a stretch of agentd's motion lane (`protocol/C6-agentd-api/T1-TRACE.md`, 动作线): the inputs it recorded go
again, in order and at their times, to a fresh Spatial and MotionChooser on a fake clock with a fake renderer, and the
decisions they make (motion.chosen, behavior.dispatched, behavior.refused) are compared with the recorded ones.

usage: motion_replay.py <trace.ndjson> [--from ISO] [--to ISO] [--out DIR] [--packs DIR]

--from / --to bound the decisions compared; the inputs go from the last spatial.began at or before --from.
--packs: a directory with one runtime character directory per pack id; without it a pack is the character library's
($AGENTD_DEV_CATALOG) runtime directory of that id.
Writes to --out (default .) replayed.ndjson (the replay's motion lane, T1 events), c1.ndjson (its C1 messages) and
diff.json; prints one summary line; exit 1 when a decision differs."""
import argparse
from contextlib import contextmanager
from datetime import datetime
import difflib
import json
import math
from pathlib import Path
import random
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import c1  # noqa: E402
from infra.store import open_store  # noqa: E402
from motion.chooser import MotionChooser  # noqa: E402
from observation import spatial  # noqa: E402
from traces.motion_lane import MotionLane  # noqa: E402
from traces.trace_store import TraceStore, new_trace_id  # noqa: E402

DECISIONS = ("motion.chosen", "behavior.dispatched", "behavior.refused")
KEY = ("kind", "type", "clip", "why", "reason")  # what a replayed decision must repeat, besides its order and time
TOLERANCE = 0.05  # seconds a replayed decision may lie from the recorded one
# t_wall cuts the clock to the ms: each event replays at the end of its ms, so the motion clock runs the frames it had
SHIFT = 0.0009
GENERATION = 1  # the turn generation is no motion-lane input: every behavior gets this one
QUIET_SITUATION = {"fullscreen": False, "user_speaking": False, "speaking": False, "voicing": False, "line_id": None,
                   "typing": False, "absence": None, "session": None, "state": "idle", "related": [],
                   "window_id": None, "activity": None, "idle_s": None}  # observe() before the first situation
CHOOSER_ENTRIES = {"step", "speech"}  # the calls that can make the chooser's decisions
BODY_ENTRIES = {"poll", "receipt", "return"}  # the calls that can make the other ones


def _time(wall):
    return datetime.fromisoformat(wall).timestamp()


def _chooser_decision(event):
    return event["kind"] == "motion.chosen" or event["attrs"].get("behavior_type") == "perform"


def _holds(events):
    """The t_wall of each moment the chooser's hold decided: its loop proposed again (a perform dispatched for no
    motion.chosen and renewing nothing) or refused."""
    causes = {e["event_id"] for e in events if e["kind"] in ("motion.chosen", "behavior.dispatched")}
    return {e["t_wall"] for e in events if e["attrs"].get("behavior_type") == "perform" and (
        e["kind"] == "behavior.refused" and e["attrs"]["trigger_event"] == "hold"
        or e["kind"] == "behavior.dispatched" and e["causation_id"] not in causes)}


def read(path):
    """agentd's events of an NDJSON export, in its order."""
    with open(path, encoding="utf-8") as stream:
        return [e for e in map(json.loads, filter(str.strip, stream)) if e.get("producer") == "agentd"]


def decisions(events, start=None, end=None):
    """The decisions between start and end (clock seconds, None for open), each as KEY with its time; a perform's
    dispatch or refusal takes clip and why from the motion.chosen it points to."""
    chosen = {e["event_id"]: e["attrs"] for e in events if e["kind"] == "motion.chosen"}
    rows = []
    for e in events:
        t = _time(e["t_wall"])
        if e["kind"] not in DECISIONS or start is not None and t < start or end is not None and t > end:
            continue
        a, cause = e["attrs"], chosen.get(e["causation_id"]) or {}
        rows.append({"kind": e["kind"], "type": a.get("behavior_type"), "clip": a.get("clip", cause.get("clip")),
                     "why": a["why"] if "why" in a else a.get("trigger_event", cause.get("why")),
                     "reason": a.get("reason"), "t_wall": e["t_wall"], "t": t})
    return rows


def compare(recorded, replayed):
    """Each difference: a recorded decision the replay did not make (missing), one it made more (extra), or one
    it made more than TOLERANCE away (time)."""
    keys = lambda rows: [tuple(r[k] for k in KEY) for r in rows]  # noqa: E731
    differences = []
    matcher = difflib.SequenceMatcher(None, keys(recorded), keys(replayed), autojunk=False)
    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        if op == "equal":
            differences += [{"op": "time", "recorded": a, "replayed": b} for a, b in
                            zip(recorded[i1:i2], replayed[j1:j2]) if abs(a["t"] - b["t"]) > TOLERANCE]
        else:
            differences += [{"op": "missing", "recorded": a} for a in recorded[i1:i2]]
            differences += [{"op": "extra", "replayed": b} for b in replayed[j1:j2]]
    return differences


@contextmanager
def _no_catch_up():
    # the replay wakes the motion clock only where the recording shows it woke, so no gap is a stall
    kept, spatial.CATCH_UP = spatial.CATCH_UP, math.inf
    try:
        yield
    finally:
        spatial.CATCH_UP = kept


class Replay:
    """One replay: Spatial's entry calls in the recording's order, and a fake renderer that answers a behavior from the
    recording when it has its receipts or motion_state, else by its clip's length."""

    def __init__(self, events, packs, scratch):
        self.events, self.packs, self.scratch = events, packs, scratch
        self.now = 0.0
        self.stage, self.situation, self.spatial = "normal", dict(QUIET_SITUATION), None
        self.c1, self.queue, self.live = [], [], {}  # live: behaviors the fake renderer answers itself
        self.turns = {}  # line_id -> the trace id that stands in for its turn's
        self.recorded_ids = [e["attrs"]["behavior_id"] for e in events if e["kind"] == "behavior.dispatched"]
        self.answered = {e["attrs"]["behavior_id"] for e in events
                         if e["kind"] in ("behavior.receipt", "motion.state") and e["attrs"]["behavior_id"]}
        self.replayed_ids = []
        self.consumed = set()  # indexes of recorded receipts already fed
        self.holds = _holds(events)
        epoch = next(e["producer_epoch"] for e in events)
        self.store = TraceStore(open_store(scratch / "replayed.sqlite3"), producer_epoch=epoch, clock=lambda: self.now,
                                mono=lambda: self.now)
        self.lane = MotionLane(self.emit)
        self.moment, self.ran = None, set()

    def emit(self, kind, trace_id, **fields):
        event_id = self.store.emit(kind, trace_id, **fields)
        if kind == "behavior.dispatched":
            self.replayed_ids.append(fields["attrs"]["behavior_id"])
        return event_id

    def publish(self, event, data):
        self.c1.append({"t": round(self.now, 3), "event": event, **data})
        self.queue.append((self.now, len(self.c1), lambda: self.answer(event, data)))
        return len(self.c1)

    def run(self):
        with _no_catch_up():
            for index, e in enumerate(self.events):
                t = _time(e["t_wall"]) + SHIFT
                self.until(t)
                self.now = max(self.now, t)
                if e["t_wall"] != self.moment:
                    self.moment, self.ran = e["t_wall"], set()
                self.handle(index, e)
                self.until(self.now)

    def until(self, t):
        """The fake renderer's own answers due by t, at their times."""
        while self.queue:
            self.queue.sort(key=lambda item: item[:2])
            if self.queue[0][0] > t:
                return
            at, _, answer = self.queue.pop(0)
            self.now = max(self.now, at)
            answer()

    def handle(self, index, e):
        kind, a, sp = e["kind"], e["attrs"], self.spatial
        if kind == "spatial.began":
            self.begin(a)
        elif sp is None:
            return  # before the stretch's first spatial.began
        elif kind == "motion.chooser":
            sp.use_motion(None if a["pack"] is None else MotionChooser(self.pack(a["pack"]), a["seeds"]))
            if a["kept"] is not None:
                path = self.scratch / "spatial.json"
                path.write_text(json.dumps({"revision": 0, "level": self.stage, "base": {"pack": a["pack"], **a["kept"]}}),
                                encoding="utf-8")
                sp.keep(path)
        elif kind == "behavior.switches":
            sp.set_switches(a["switches"])
        elif kind == "behavior.capabilities":
            sp.set_capabilities(a["character"], a["capabilities"])
        elif kind == "behavior.cancel_all":
            sp.cancel_all(a["reason"])
        elif kind == "interaction.preset":
            sp.set_interaction(a["preset"])
        elif kind == "motion.prefs":
            sp.set_motion_prefs(a["action_switches"], a["motion_overrides"])
        elif kind == "situation.observed":
            voicing = self.situation["voicing"]
            self.situation = self.observed(a)
            if a["by"] == "poll":
                if a["voicing"] != voicing:  # the poll tells the chooser
                    self.ran.add("speech")
                self.entry("poll", sp.poll)
            elif a["by"] == "step":
                self.entry("step", self.step)
        elif kind == "signal.changed":
            self.lane.write(kind, new_trace_id(), None, a, input=True)
        elif kind == "stage.changed":
            self.stage = a["to"]
            trace_id, cause = self.lane.newest if self.lane.newest else (new_trace_id(), None)
            self.lane.write(kind, trace_id, cause, a, input=True)
            self.entry("speech" if a["to"] == "quiet" else "stage", lambda: sp.stage_event("stage." + a["to"]))
        elif kind == "motion.intent":
            sp.motion_intent(a, False)
        elif kind == "motion.input":
            self.entry("speech", lambda: sp.motion(a["item"]))
        elif kind == "motion.return":
            self.entry("return", lambda: sp.perform_return(dict(a)))
            self.ran.add("speech")
        elif kind == "motion.clock":
            self.catch_up(a["frames"])
        elif kind == "motion.state":
            behavior_id = a["behavior_id"] and self.replayed(a["behavior_id"])
            if a["behavior_id"] is None or behavior_id is not None:
                sp.motion_state({**a, "behavior_id": behavior_id, "resting": False, "busy": False})
        elif kind == "behavior.receipt":
            if index not in self.consumed:
                self.feed(index)
        elif kind in DECISIONS:
            self.wake(index, e)

    def begin(self, a):
        """A fresh Spatial as agentd started it; the renderer's own answers of the last one are dropped."""
        self.stage, self.queue, self.live = a["stage"], [], {}
        self.spatial = spatial.Spatial(
            lambda: dict(self.situation), self.publish, lambda: GENERATION, a["epoch"], clock=lambda: self.now,
            rng=random.Random(a["seed"]), lane=self.lane, stage=lambda: self.stage, interaction_preset=a["preset"],
            session_settle=a["session_settle"], session_min_hold=a["session_min_hold"],
            recovery_delay=a["recovery_delay"])
        self.spatial.begin()

    def pack(self, pack_id):
        if self.packs is not None:
            return Path(self.packs) / pack_id
        from brain.characters import Repository
        return Repository().package(pack_id).root / "runtime" / "characters" / pack_id

    def observed(self, a):
        """observe() as situation.observed recorded it."""
        s = {k: a[k] for k in QUIET_SITUATION if k in a}
        s.update(absence=None if a["absence_since"] is None else {"id": "replay", "since": a["absence_since"]},
                 idle_s={None: None, "active": 0.0, "quiet": spatial.QUIET}[a["idle"]])
        if a["turn_traced"]:
            s["turn_trace"] = (self.turns.setdefault(a["line_id"], new_trace_id()), a["line_id"], None)
        return s

    def entry(self, name, call):
        self.ran.add(name)
        call()

    def wake(self, index, e):
        """A recorded decision no input of its moment can have made: the motion clock or the poll woke there. A body
        decision before a blocked receipt of the same moment came from that receipt's retarget."""
        if _chooser_decision(e):
            if not self.ran & CHOOSER_ENTRIES:
                self.entry("step", self.step)
            return
        if self.ran & BODY_ENTRIES:
            return
        blocked = next((i for i in range(index + 1, len(self.events)) if self.events[i]["t_wall"] == e["t_wall"]
                        and self.events[i]["kind"] == "behavior.receipt" and i not in self.consumed
                        and self.events[i]["attrs"]["phase"] == "blocked"), None)
        if blocked is not None:
            self.ran.add("receipt")
            self.feed(blocked)
        else:
            self.entry("poll", self.spatial.poll)

    def step(self):
        """One wake of the motion clock. Its hold retries every HOLD_RETRY on wakes the recording does not show, and the
        lane writes a run of the same refusal once, so the hold tries where the recording shows it decided and only
        there."""
        self.spatial._hold_at = -math.inf if self.moment in self.holds else math.inf
        self.spatial.motion_step()

    def catch_up(self, frames):
        """The motion clock's frames up to the count the recording's chooser had run when an input read it."""
        sp = self.spatial
        with sp._lock:
            if sp.chooser is None or sp._motion_at is None:
                return
            missing = frames - round(sp.chooser.t_s / spatial.FRAME)
            if missing > 0:
                sp._advance(sp._motion_at + (missing + 0.5) * spatial.FRAME)

    def replayed(self, recorded_id):
        """The replayed behavior that stands for a recorded one: the same place among the dispatched, else the same
        id; None when the replay has none."""
        if recorded_id in self.recorded_ids:
            place = self.recorded_ids.index(recorded_id)
            return self.replayed_ids[place] if place < len(self.replayed_ids) else None
        return recorded_id if recorded_id in self.spatial.records else None

    def recorded(self, behavior_id):
        if behavior_id in self.replayed_ids:
            place = self.replayed_ids.index(behavior_id)
            return self.recorded_ids[place] if place < len(self.recorded_ids) else None
        return behavior_id

    def feed(self, index):
        self.consumed.add(index)
        a = self.events[index]["attrs"]
        behavior_id = self.replayed(a["behavior_id"])
        if behavior_id is not None:
            self.receipt(behavior_id, a["phase"], a["reason"])

    def receipt(self, behavior_id, phase, reason):
        """One receipt to Spatial, mirrored into the replay's lane once applied, as POST /behavior/receipts does."""
        record = self.spatial.records.get(behavior_id)
        generation = GENERATION if record is None else record["behavior"]["turn_generation"]
        if phase in c1.ENDED:
            self.live.pop(behavior_id, None)
        applied, _ = self.spatial.receipt({"behavior_id": behavior_id, "phase": phase, "reason": reason,
                                           "at_ms": int(self.now * 1000), "turn_generation": generation})
        linkage = self.spatial.receipt_trace(behavior_id) if applied else None
        if linkage is not None:
            trace_id, turn_id, behavior_type, _ = linkage
            self.store.emit("behavior.receipt", trace_id, turn_id=turn_id,
                            turn_generation=None if turn_id is None else generation,
                            attrs={"behavior_id": behavior_id, "behavior_type": behavior_type, "phase": phase,
                                   "reason": reason})

    def answer(self, event, data):
        """The fake renderer, for a behavior the recording has no answers for: prepared and running at once, a
        one-shot clip's end after its length, cancelled when cancelled or replaced, expired when it runs out."""
        if event == "behavior_cancel" and data["behavior_id"] in self.live:
            self.receipt(data["behavior_id"], "cancelled", None)
        if event != "behavior" or self.recorded(data["behavior_id"]) in self.answered:
            return
        behavior_id, sp = data["behavior_id"], self.spatial
        if data["replaces"] in self.live:
            self.receipt(data["replaces"], "cancelled", None)
        self.live[behavior_id] = data
        self.receipt(behavior_id, "prepared", None)
        self.receipt(behavior_id, "running", None)
        clip = (data.get("clip") or {}).get("id")
        if clip is not None and not data.get("loop") and sp.chooser is not None and clip in sp.chooser.pack.lengths:
            self.queue.append((self.now + sp.chooser.pack.lengths[clip], len(self.c1), lambda: self.ended(behavior_id)))
        self.queue.append((data["expires_at_ms"] / 1000, len(self.c1), lambda: self.expired(behavior_id)))

    def ended(self, behavior_id):
        data = self.live.get(behavior_id)
        if data is not None:
            self.spatial.motion_state({"behavior_id": behavior_id, "origin": "agent", "phase": "ended",
                                       "resting": False, "busy": False, "clip": data["clip"]["id"]})
            self.receipt(behavior_id, "completed", None)

    def expired(self, behavior_id):
        if behavior_id in self.live:
            self.receipt(behavior_id, "expired", None)


def replay(events, packs=None, start=None, end=None):
    """{replayed: the replay's T1 events, c1: its C1 messages, recorded / replayed: the decisions compared on each
    side, differences}; start / end: ISO times bounding the decisions compared."""
    begin, finish = start and _time(start), end and _time(end)
    began = [i for i, e in enumerate(events) if e["kind"] == "spatial.began" and (begin is None or _time(e["t_wall"]) <= begin)]
    if not began:
        raise ValueError("no spatial.began at or before the stretch")
    stretch = [e for e in events[began[-1] if begin is not None else began[0]:]
               if finish is None or _time(e["t_wall"]) <= finish]
    with tempfile.TemporaryDirectory() as scratch:
        run = Replay(stretch, packs, Path(scratch))
        run.run()
        replayed = run.store.export()
        run.store.db.close()
    recorded, again = decisions(stretch, begin, finish), decisions(replayed, begin, finish)
    return {"replayed": replayed, "c1": run.c1, "recorded": len(recorded), "replayed_decisions": len(again),
            "differences": compare(recorded, again)}


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("trace")
    parser.add_argument("--from", dest="start")
    parser.add_argument("--to", dest="end")
    parser.add_argument("--out", default=".")
    parser.add_argument("--packs")
    args = parser.parse_args(argv)
    result = replay(read(args.trace), args.packs, args.start, args.end)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "replayed.ndjson").write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in result["replayed"]),
                                         encoding="utf-8")
    (out / "c1.ndjson").write_text("".join(json.dumps(m, ensure_ascii=False) + "\n" for m in result["c1"]),
                                   encoding="utf-8")
    diff = {"recorded": result["recorded"], "replayed": result["replayed_decisions"],
            "differences": result["differences"]}
    (out / "diff.json").write_text(json.dumps(diff, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"motion replay: {diff['recorded']} recorded decisions, {diff['replayed']} replayed, "
          f"{len(diff['differences'])} differences")
    return 1 if diff["differences"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
