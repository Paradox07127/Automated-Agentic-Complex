"""GET /characters/<id>/mod-settings: each appearance's settings from the installed pack's interaction/mod-settings.json."""
from pathlib import PurePosixPath

from character_library import PackageError, read_json
from route_registry import CHARACTER_MOD_SETTINGS_PATH

SCHEMA = "endfield-mod-settings/v1"
FIELDS = ("id", "name", "category", "values", "default")


def read(package):
    """(the installed pack.json, {schema, appearances} of its mod settings); pack.json is None for a text-only package.
    Raises PackageError when an installed file changed since install."""
    table = dict(schema=SCHEMA, appearances={})
    if package.native_entry is None:  # a text-only package has no C7 pack
        return None, table
    c7 = PurePosixPath(package.native_ref["file"]).parent / package.native_entry["c7"]["file"]
    pack = read_json(package.resolve(dict(package.native_entry["c7"], file=str(c7))))
    ref = next((r for r in pack.get("interaction", {}).get("data", []) if r.get("file") == "mod-settings.json"), None)
    if ref is not None:
        data = read_json(package.resolve(dict(ref, file=str(c7.parent / "interaction" / "mod-settings.json"))))
        table.update(schema=data["schema"], appearances={
            appearance: {"settings": [{k: s[k] for k in FIELDS if k in s} for s in entry["settings"]]}
            for appearance, entry in data["appearances"].items()})
    return pack, table


def route(h, method, path):
    match = CHARACTER_MOD_SETTINGS_PATH.fullmatch(path)
    if match is None:
        return False
    try:
        package = h.server.characters.package(match[1])
    except ValueError:
        h.json(404, {"error": "unknown_character"})
        return True
    try:
        table = read(package)[1]
    except PackageError as error:  # an installed file changed since install
        h.json(409, {"error": str(error)})
        return True
    h.json(200, dict(character=package.id, package_sha256=package.sha256, **table))
    return True
