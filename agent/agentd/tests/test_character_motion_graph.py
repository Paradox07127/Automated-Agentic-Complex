"""GET /characters/<id>/motion-graph answers the installed pack's animation/motion-graph.json."""
import hashlib
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from brain.characters import Repository
from character_library import Library, write_json
import support
from test_character_binding import BindingCase
from test_character_library import fixture
import test_server as helpers

GRAPH = {"schema": "endfield-motion-graph/v1", "character": "fixture", "crossfade_s": 0.25,
         "groups": [{"id": "base", "title": "基础站姿与桥接", "parent": None}],
         "clips": [{"name": "idle", "loop": True, "length": 1.0, "uses": []}],
         "edges": [{"from": "idle", "to": "idle", "gap": 0.0}], "chains": {"idle": [{"clip": "idle"}]},
         "counts": {"clips": 1, "edges": 1, "chains": 1}}


def with_graph(root, graph):
    """The fixture package with graph written to runtime/animation/motion-graph.json and inventoried."""
    doc = fixture(root)
    data = (json.dumps(graph, ensure_ascii=False, indent=2) + "\n").encode()
    path = "runtime/animation/motion-graph.json"
    (root / path).parent.mkdir(parents=True, exist_ok=True); (root / path).write_bytes(data)
    doc["inventory"].append(dict(file=path, sha256=hashlib.sha256(data).hexdigest(), byte_count=len(data)))
    write_json(root / "character.json", doc)


class MotionGraphRouteTest(BindingCase):
    def install(self, graph):
        source, library = self.state_dir / "source", self.state_dir / "library"
        if graph is None:
            fixture(source)
        else:
            with_graph(source, graph)
        Library(library).install(source)
        self.server.characters = Repository(library / "current.json")

    def test_the_installed_graph_as_it_is(self):
        self.install(GRAPH)
        sha = self.server.characters.package("fixture").sha256
        self.assertEqual(self.request("GET", "/characters/fixture/motion-graph"), (200, dict(GRAPH, package_sha256=sha)))

    def test_a_pack_without_a_graph(self):
        self.install(None)
        self.assertEqual(self.request("GET", "/characters/fixture/motion-graph"), (404, {"error": "motion_graph_missing"}))

    def test_unknown_character(self):
        self.install(GRAPH)
        self.assertEqual(self.request("GET", "/characters/unknown/motion-graph"), (404, {"error": "unknown_character"}))

    def test_only_the_ui_token_reads_it(self):
        self.install(GRAPH)
        for token in (None, helpers.HOOK, helpers.EVENTS):
            self.assertEqual(self.request("GET", "/characters/fixture/motion-graph", token=token),
                             (401, {"error": "unauthorized"}))
        self.assertEqual(self.request("GET", "/characters/fixture/motion-graph", token=support.UI)[0], 200)


if __name__ == "__main__":
    unittest.main()
