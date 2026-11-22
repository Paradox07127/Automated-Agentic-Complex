"""GET /characters/<id>/motion-graph: the installed pack's animation/motion-graph.json plus the pack's character.json sha256.
GET /characters/<id>/motion-groups: the current character's proposed pool members (motion.groups.propose)."""
from pathlib import PurePosixPath

from character_library import read_json
from motion.groups import propose
from route_registry import CHARACTER_MOTION_GRAPH_PATH, CHARACTER_MOTION_GROUPS_PATH


def route(h, method, path):
    match = CHARACTER_MOTION_GROUPS_PATH.fullmatch(path)
    if match is not None:
        return _groups(h, match[1])
    match = CHARACTER_MOTION_GRAPH_PATH.fullmatch(path)
    if match is None:
        return False
    try:
        package = h.server.characters.package(match[1])
    except ValueError:
        h.json(404, {"error": "unknown_character"})
        return True
    ref = None
    if package.native_entry is not None:  # a text-only package has no C7 pack
        pack = PurePosixPath(package.native_ref["file"]).parent / package.native_entry["c7"]["file"]
        ref = package.inventory.get(str(pack.parent / "animation" / "motion-graph.json"))
    if ref is None:
        h.json(404, {"error": "motion_graph_missing"})
    else:
        h.json(200, dict(read_json(package.resolve(ref)), package_sha256=package.sha256))
    return True


def _groups(h, cid):
    if cid != h.server.character:
        h.json(409, {"error": "not_current"})
        return True
    chooser = h.server.spatial.chooser
    graph = None if chooser is None else chooser.pack.c7 / "animation" / "motion-graph.json"
    if graph is None or not graph.is_file():
        h.json(404, {"error": "motion_graph_missing"})
    else:
        h.json(200, propose(chooser, read_json(graph)))
    return True
