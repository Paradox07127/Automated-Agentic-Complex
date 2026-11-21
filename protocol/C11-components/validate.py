"""Check C11 manifests, locks, split import indexes, or a lock with its manifests. Exit 0 when valid."""
from datetime import datetime
import json
import re
import sys

COMPONENT_REQUIRED = ("schema", "id", "version", "tree_sha256", "files", "bytes",
                      "entrypoints", "provides", "requires", "platform")
LOCK_REQUIRED = ("schema", "edition", "platform", "created_at", "host", "components")
ID = re.compile(r"[a-z][a-z0-9._-]{0,63}")
INTERFACE = re.compile(r"[A-Z][A-Za-z0-9.-]{0,63}")
VERSION = re.compile(r"[0-9]+(?:\.[0-9]+)*")
SHA256 = re.compile(r"[0-9a-f]{64}")
PLATFORMS = ("macos-arm64", "windows-x64")


def check_identity(doc, label):
    if not isinstance(doc, dict):
        return f"{label} must be an object"
    for key, pattern, expected in (("id", ID, "match ^[a-z][a-z0-9._-]{0,63}$"),
                                   ("version", VERSION, "be a numeric dotted version string"),
                                   ("tree_sha256", SHA256, "be 64 lowercase hex")):
        if key not in doc:
            return f"{label}: missing field {key}"
        if not isinstance(doc[key], str) or not pattern.fullmatch(doc[key]):
            return f"{label}.{key} must {expected}"
    return None


def check_component(doc):
    if not isinstance(doc, dict):
        return "component must be an object"
    for key in COMPONENT_REQUIRED:
        if key not in doc:
            return f"component: missing field {key}"
    if doc["schema"] != "endfield-component/v1":
        return "component.schema must be endfield-component/v1"
    err = check_identity(doc, "component")
    if err:
        return err
    if doc["platform"] not in PLATFORMS:
        return "component.platform must be macos-arm64 or windows-x64"
    for key in ("files", "bytes"):
        if type(doc[key]) is not int or doc[key] < 0:
            return f"component.{key} must be a nonnegative integer"
    if not isinstance(doc["entrypoints"], dict):
        return "component.entrypoints must be an object"
    for name, path in doc["entrypoints"].items():
        if not isinstance(name, str) or not name:
            return "component.entrypoints names must be nonempty strings"
        if (not isinstance(path, str) or "\\" in path or "\0" in path
                or any(part in ("", ".", "..") for part in path.split("/"))):
            return f"component.entrypoints.{name} must be a relative POSIX path without . or .."
    if "placed" in doc:
        if doc["id"] not in ("host", "renderer"):
            return "component.placed is only allowed for host and renderer"
        if not isinstance(doc["placed"], dict):
            return "component.placed must be an object"
        for source, target in doc["placed"].items():
            for side, path in (("source", source), ("target", target)):
                if (not isinstance(path, str) or "\\" in path or "\0" in path
                        or any(part in ("", ".", "..") for part in path.split("/"))):
                    return f"component.placed {side} must be a relative POSIX path without . or .."
    for key in ("provides", "requires"):
        if not isinstance(doc[key], dict):
            return f"component.{key} must be an object"
        for name, version in doc[key].items():
            valid_name = isinstance(name, str) and (
                INTERFACE.fullmatch(name) or (key == "requires" and ID.fullmatch(name)))
            if not valid_name:
                return f"component.{key}: invalid id {name!r}"
            if not isinstance(version, str) or not VERSION.fullmatch(version):
                return f"component.{key}.{name} must be a numeric dotted version string"
    return None


def check_lock(doc):
    if not isinstance(doc, dict):
        return "lock must be an object"
    for key in LOCK_REQUIRED:
        if key not in doc:
            return f"lock: missing field {key}"
    if doc["schema"] != "endfield-composition/v1":
        return "lock.schema must be endfield-composition/v1"
    if doc["edition"] not in ("portable", "split"):
        return "lock.edition must be portable or split"
    if doc["platform"] not in PLATFORMS:
        return "lock.platform must be macos-arm64 or windows-x64"
    created_at = doc["created_at"]
    if not isinstance(created_at, str) or not re.fullmatch(r"[0-9]{4}(-[0-9]{2}){2}T[0-9]{2}(:[0-9]{2}){2}Z", created_at):
        return "lock.created_at must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ"
    try:
        datetime.strptime(created_at, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return "lock.created_at must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ"
    err = check_identity(doc["host"], "lock.host")
    if err:
        return err
    if not isinstance(doc["components"], list):
        return "lock.components must be an array"
    ids = {doc["host"]["id"]}
    for index, component in enumerate(doc["components"]):
        err = check_identity(component, f"lock.components[{index}]")
        if err:
            return err
        if component["id"] in ids:
            return f"lock: duplicate id {component['id']}"
        ids.add(component["id"])
        if "placement" not in component:
            return f"lock.components[{index}]: missing field placement"
        placement = "bundle" if doc["edition"] == "portable" or component["id"] in ("renderer", "web-ui") else "support"
        if component["placement"] != placement:
            return f"lock.components[{index}].placement must be {placement} for {doc['edition']}"
    return None


def check_index(doc):
    if not isinstance(doc, dict):
        return "index must be an object"
    for key in ("schema", "components"):
        if key not in doc:
            return f"index: missing field {key}"
    if doc["schema"] != "endfield-components-index/v1":
        return "index.schema must be endfield-components-index/v1"
    if not isinstance(doc["components"], list):
        return "index.components must be an array"
    ids = set()
    for index, component in enumerate(doc["components"]):
        label = f"index.components[{index}]"
        err = check_identity(component, label)
        if err:
            return err
        if component["id"] in ("host", "renderer", "web-ui"):
            return f"{label}.id {component['id']} stays in the app"
        if component["id"] in ids:
            return f"index: duplicate id {component['id']}"
        ids.add(component["id"])
        if "dir" not in component:
            return f"{label}: missing field dir"
        path = component["dir"]
        if (not isinstance(path, str) or "\\" in path or "\0" in path
                or any(part in ("", ".", "..") for part in path.split("/"))):
            return f"{label}.dir must be a relative POSIX path without . or .."
    return None


def check_composition(lock, manifests):
    """Check a validated lock against validated component manifests."""
    entries = {entry["id"]: entry for entry in [lock["host"], *lock["components"]]}
    ids = set()
    for manifest in manifests:
        component_id = manifest["id"]
        if component_id in ids:
            return f"component {component_id}: duplicate manifest"
        if component_id not in entries:
            return f"component {component_id}: missing lock entry"
        ids.add(component_id)
        entry = entries[component_id]
        for key in ("version", "tree_sha256"):
            if manifest[key] != entry[key]:
                return f"component {component_id}.{key} must be {entry[key]} from lock"
        if manifest["platform"] != lock["platform"]:
            return f"component {component_id}.platform must be {lock['platform']} from lock"
    for component_id in entries:
        if component_id not in ids:
            return f"component {component_id}: missing manifest"
    provided = {(name, version) for manifest in manifests
                for name, version in manifest["provides"].items()}
    for manifest in manifests:
        for name, version in manifest["requires"].items():
            label = f"component {manifest['id']}.requires.{name}"
            if INTERFACE.fullmatch(name):
                if (name, version) not in provided:
                    return f"{label}: missing provider for version {version}"
            elif name not in entries:
                return f"{label}: missing component"
            elif entries[name]["version"] != version:
                return f"{label}: expected version {version}, got {entries[name]['version']}"
    return None


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as f:
        try:
            doc = json.load(f)
        except ValueError:
            print("not JSON")
            sys.exit(1)
    if len(sys.argv) > 2:
        err = check_lock(doc)
    elif isinstance(doc, dict) and doc.get("schema") == "endfield-component/v1":
        err = check_component(doc)
    elif isinstance(doc, dict) and doc.get("schema") == "endfield-composition/v1":
        err = check_lock(doc)
    elif isinstance(doc, dict) and doc.get("schema") == "endfield-components-index/v1":
        err = check_index(doc)
    else:
        err = "unknown schema"
    if not err and len(sys.argv) > 2:
        manifests = []
        for path in sys.argv[2:]:
            with open(path, encoding="utf-8") as f:
                try:
                    manifest = json.load(f)
                except ValueError:
                    err = "not JSON"
                    break
            err = check_component(manifest)
            if err:
                break
            manifests.append(manifest)
        if not err:
            err = check_composition(doc, manifests)
    if err:
        print(err)
    sys.exit(1 if err else 0)
