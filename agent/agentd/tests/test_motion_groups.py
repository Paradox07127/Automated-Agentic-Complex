"""Proposed pool members for the clips a pack does not draw, and GET /characters/<id>/motion-groups, on the demo pack with
one hand-made clip per rule kind."""
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from api.handler import Handler  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from motion.chooser import EVENT_RULES, MotionChooser  # noqa: E402
from motion.groups import propose  # noqa: E402
import support  # noqa: E402
from test_c6_fixtures import mismatches  # noqa: E402

PACK = Path(__file__).resolve().parent / "fixtures" / "motion-chooser" / "demo"
FIXTURES = Path(__file__).resolve().parents[3] / "protocol" / "C6-agentd-api" / "fixtures"
# name -> (length, loop, stance start, stance end, next, the graph group)
ADDED = {
    "hero_battle_stance": (2.0, True, "stand", "stand", None, "unwired"),  # an exclusion rule
    "hero_dialog_single_bow": (2.0, False, "stand", "stand", None, "unwired"),  # a token rule
    "hero_dialog_single_kneel": (2.0, False, "stand", "floor", None, "unwired"),  # a token rule, no return
    "hero_dialog_single_sitnod": (2.0, False, "sit", "sit", None, "unwired"),  # a token rule, to the sit tier
    "sway_loop": (3.0, True, "stand", "stand", None, "unwired"),  # a loop in the idle stance
    "blink": (1.0, False, "stand", "stand", None, "unwired"),  # a short standing one-shot
    "pose_start": (1.0, False, "stand", "stand", "pose_hold", "unwired"),  # a start/loop/end chain
    "pose_hold": (2.0, True, "stand", "stand", "pose_end", "unwired"),
    "pose_end": (1.0, False, "stand", "stand", None, "unwired"),
    "long_kneel": (6.0, False, "stand", "stand", None, "unwired"),  # no rule
    "hero_surprise": (6.0, False, "stand", "stand", None, "unwired"),  # a meaning word, reaction keys
    "hero_sit_think": (3.0, True, "sit", "sit", None, "unwired"),  # meaning words on a seated clip
    "hero_battle_wave": (2.0, False, "stand", "stand", None, "unwired"),  # a meaning word an exclusion rule beats
}
DEMO_GROUPS = {"base_loop": "base", "relax_loop": "base", "to_relax": "base", "point": "speech", "sit_enter": "seat",
               "sit_loop": "seat", "think_loop": "session.thinking", "pat_react": "click", "look_left": "click",
               "tap": "click", "wave": "click", "cheer": "session.done"}


def groups_pack(root):
    """The demo pack in root as `hero`, with the ADDED clips, a sit idle tier of sit_loop and a hand-made motion graph."""
    pack = Path(root) / "hero"
    shutil.copytree(PACK, pack)

    def edit(name, change):
        path = pack / name
        doc = json.loads(path.read_text(encoding="utf-8"))
        change(doc)
        path.write_text(json.dumps(doc), encoding="utf-8")

    def motion_map(m):
        for name, (_, _, _, _, nxt, _) in ADDED.items():
            m["clips"][name] = {"interruptible": True, **({"next": nxt} if nxt else {})}
        m["clips"]["pose_hold"]["hold_seconds"] = 2.0
        m["idle_tiers"].append({"after_s": [5, 10], "stance": "sit", "pool": [{"clip": "sit_loop"}]})
    edit("actor/manifest.json", lambda d: d["clips"].extend(
        {"name": n, "length": r[0], "loop": r[1]} for n, r in ADDED.items()))
    edit("c7/animation/palette-contract.json", lambda d: d["clips"].extend(
        {"name": n, "loop": r[1]} for n, r in ADDED.items()))
    edit("c7/animation/intent-motion-map.json", motion_map)
    edit("c7/interaction/motion-metadata.json", lambda d: d["clips"].update(
        {n: {"stance_start": r[2], "stance_end": r[3]} for n, r in ADDED.items()}))
    edit("c7/pack.json", lambda d: d["animation"]["data"].append({"file": "motion-graph.json"}))
    manifest = json.loads((pack / "actor" / "manifest.json").read_text(encoding="utf-8"))["clips"]
    groups = dict(DEMO_GROUPS, **{n: r[5] for n, r in ADDED.items()})
    members = {"relax_loop", "pose_hold", "pose_end"}
    graph = {"schema": "endfield-motion-graph/v1", "character": "hero",
             "clips": [{"name": c["name"], "group": groups.get(c["name"], "idle"), "loop": c["loop"],
                        "length_s": c["length"]} for c in manifest],
             "chains": {c["name"]: [{"clip": c["name"]}] for c in manifest if c["name"] not in members}}
    (pack / "c7" / "animation" / "motion-graph.json").write_text(json.dumps(graph), encoding="utf-8")
    return pack, graph


class ProposeTest(unittest.TestCase):
    def setUp(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        self.pack, self.graph = groups_pack(root)
        self.chooser = MotionChooser(self.pack)

    def test_each_rule_kind_proposes_rejects_excludes_or_leaves_its_clip(self):
        out = propose(self.chooser, self.graph)
        self.assertEqual(out["character"], "hero")
        pools = out["pools"]
        self.assertEqual(set(pools), set(EVENT_RULES) | {"idle.t1", "idle.t2"})
        self.assertEqual(pools["pinch.cheek"]["pack"], [])
        one = lambda clip, why: {"clip": clip, "weight": 1, "why": why}  # noqa: E731
        self.assertEqual(pools["idle.t1"], {
            "posture": "stand",
            "pack": [{"clip": "nod", "weight": 1}, {"clip": "shrug", "weight": 1}, {"clip": "stretch", "weight": 1}],
            "proposal": [one("hero_dialog_single_bow", "token:dialog_single"), one("sway_loop", "structure:loop"),
                         one("pose_start", "structure:chain")],
            "rejected": [{"clip": "hero_dialog_single_kneel", "reason": "no_return"}]})
        self.assertEqual(pools["idle.t2"], {"posture": "sit", "pack": [{"clip": "sit_loop", "weight": 1}],
                                            "proposal": [one("hero_dialog_single_sitnod", "token:dialog_single")],
                                            "rejected": []})
        self.assertEqual(pools["click.single"]["pack"], [{"clip": "tap", "weight": 1}, {"clip": "nod", "weight": 1}])
        self.assertEqual(pools["click.single"]["proposal"], [one("blink", "structure:one_shot"),
                                                             one("hero_surprise", "meaning:startled")])
        self.assertEqual(pools["user.greet"]["proposal"], [one("hero_dialog_single_bow", "meaning:greet")])
        self.assertEqual(pools["session.thinking@sit"]["proposal"], [one("sit_loop", "meaning:seated"),
                                                                     one("hero_sit_think", "meaning:think")])
        self.assertEqual(out["excluded"], [{"clip": c, "reason": "wired"} for c in
                                           ("base_loop", "relax_loop", "to_relax", "point", "sit_enter")]
                         + [{"clip": "hero_battle_stance", "reason": "battle"},
                            {"clip": "pose_hold", "reason": "in_chain"}, {"clip": "pose_end", "reason": "in_chain"},
                            {"clip": "hero_battle_wave", "reason": "battle"}])
        self.assertEqual(out["unclassified"], ["long_kneel"])
        self.assertEqual(out["counts"], {"clips": 28, "pooled": 10, "proposed": 7, "rejected": 1, "excluded": 9,
                                         "unclassified": 1, "proposals": 25})

    def test_every_clip_is_counted_once_by_its_first_place(self):
        out = propose(self.chooser, self.graph)
        pooled = {r["clip"] for p in out["pools"].values() for r in p["pack"]}
        proposed = {r["clip"] for p in out["pools"].values() for r in p["proposal"]}
        rejected = {r["clip"] for p in out["pools"].values() for r in p["rejected"]}
        excluded = [r["clip"] for r in out["excluded"]]
        first = {}
        for c in self.graph["clips"]:
            c = c["name"]
            first[c] = next(k for k, clips in (("pooled", pooled), ("proposed", proposed), ("rejected", rejected),
                                               ("excluded", excluded), ("unclassified", out["unclassified"]))
                            if c in clips)
        counts = out["counts"]
        self.assertEqual({k: list(first.values()).count(k) for k in ("pooled", "proposed", "rejected", "excluded",
                                                                     "unclassified")},
                         {k: v for k, v in counts.items() if k not in ("clips", "proposals")})
        self.assertEqual(counts["clips"], len(first))
        self.assertEqual(counts["proposals"], sum(len(p["proposal"]) for p in out["pools"].values()))
        self.assertFalse(set(excluded + out["unclassified"]) & (pooled | proposed | rejected))

    def test_a_word_matched_clip_is_proposed_for_each_key_its_meaning_names(self):
        pools = propose(self.chooser, self.graph)["pools"]
        for key in ("pinch.cheek", "click.single", "click.repeat"):
            self.assertIn({"clip": "hero_surprise", "weight": 1, "why": "meaning:startled"}, pools[key]["proposal"], key)

    def test_a_seated_clip_goes_to_sit_keys_only(self):
        pools = propose(self.chooser, self.graph)["pools"]
        placed = {k: r["why"] for k, p in pools.items() for r in p["proposal"] + p["rejected"]
                  if r["clip"] == "hero_sit_think"}
        self.assertEqual(placed, {"session.thinking@sit": "meaning:think", "session.tool@sit": "meaning:think",
                                  "session.subagent@sit": "meaning:seated", "rest.sleep@sit": "meaning:seated"})

    def test_a_pooled_clip_is_proposed_for_other_pools_than_its_own(self):
        pools = propose(self.chooser, self.graph)["pools"]
        placed = lambda clip: {k: r["why"] for k, p in pools.items() for r in p["proposal"]  # noqa: E731
                               if r["clip"] == clip}
        self.assertEqual(placed("nod"), {"session.done": "meaning:nod", "session.input": "meaning:nod"})
        self.assertEqual(placed("look_left"), {"look.right": "meaning:look", "user.hover": "meaning:look"})
        self.assertEqual(placed("wave"), {"present.snap": "meaning:greet", "character.enter": "meaning:greet"})

    def test_an_exclusion_rule_removes_a_clip_everywhere(self):
        out = propose(self.chooser, self.graph)
        self.assertIn({"clip": "hero_battle_wave", "reason": "battle"}, out["excluded"])
        self.assertEqual([k for k, p in out["pools"].items() for r in p["proposal"] + p["rejected"]
                          if r["clip"] == "hero_battle_wave"], [])

    def test_every_proposal_passes_the_chooser_s_pool_check(self):
        out = propose(self.chooser, self.graph)
        for key, pool in out["pools"].items():
            rows = pool["pack"] + [{"clip": r["clip"], "weight": r["weight"]} for r in pool["proposal"]]
            self.assertEqual(self.chooser.set_motion_overrides({}, {key: rows}, {}), [], key)


class MotionGroupsRouteTest(unittest.TestCase):
    def setUp(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        self.pack, self.graph = groups_pack(root)
        with mock.patch.object(AgentdServer, "server_bind"), mock.patch.object(AgentdServer, "server_activate"):
            self.server = AgentdServer(("127.0.0.1", 48810), "hook-token", support.UI, events_token="events-token")
        self.addCleanup(self.server.server_close)
        self.server.server_port = 48810
        self.server.character = "hero"
        self.server.spatial.use_motion(MotionChooser(self.pack))

    def request(self, path, token=support.UI):
        auth = "" if token is None else f"Authorization: Bearer {token}\r\n"
        handler = Handler.__new__(Handler)
        handler.server = self.server
        handler.rfile = io.BytesIO(f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:48810\r\n{auth}\r\n".encode())
        handler.wfile = io.BytesIO()
        handler.handle_one_request()
        headers, body = handler.wfile.getvalue().split(b"\r\n\r\n", 1)
        return int(headers.split()[1]), json.loads(body)

    def test_the_current_character_s_proposals(self):
        status, body = self.request("/characters/hero/motion-groups")
        self.assertEqual(status, 200)
        self.assertEqual(body, propose(self.server.spatial.chooser, self.graph))

    def test_the_body_matches_the_c6_fixture(self):
        loose = json.loads((FIXTURES / "loose-fields.json").read_text(encoding="utf-8"))
        fixture = json.loads((FIXTURES / "motion-groups.json").read_text(encoding="utf-8"))
        body = self.request("/characters/hero/motion-groups")[1]
        self.assertEqual(mismatches(fixture, body, loose["nullable"].get("motion-groups.json", []),
                                    loose["free_keys"].get("motion-groups.json", [])), [])

    def test_another_character_is_not_current(self):
        self.assertEqual(self.request("/characters/aster/motion-groups"), (409, {"error": "not_current"}))

    def test_a_character_without_a_motion_pack(self):
        self.server.spatial.use_motion(None)
        self.assertEqual(self.request("/characters/hero/motion-groups"), (404, {"error": "motion_graph_missing"}))
        self.server.spatial.use_motion(MotionChooser(self.pack))
        (self.pack / "c7" / "animation" / "motion-graph.json").unlink()
        self.assertEqual(self.request("/characters/hero/motion-groups"), (404, {"error": "motion_graph_missing"}))

    def test_only_the_ui_token_reads_it(self):
        for token in (None, "hook-token", "events-token"):
            self.assertEqual(self.request("/characters/hero/motion-groups", token), (401, {"error": "unauthorized"}))


if __name__ == "__main__":
    unittest.main()
