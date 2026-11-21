"""GET /characters/<id>/motion-graph: the installed pack's animation/motion-graph.json plus the pack's character.json sha256."""
from pathlib import PurePosixPath

from character_library import read_json
from route_registry import CHARACTER_MOTION_GRAPH_PATH


def route(h, method, path):
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
