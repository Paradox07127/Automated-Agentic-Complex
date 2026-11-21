"""Character data by id.The app passes a character library (Repository with a catalog); without one,
development and tests read $AGENTD_DEV_CATALOG, else the public sample library characters/sample-library/current.json.
The id is also the TTS service's character unless the card's tts block says otherwise."""
import copy
import hashlib
import json
import os
from pathlib import Path

from infra.platform import long_path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]  # the repository; the app passes its own library, so only development reads this one
DEV_CATALOG = Path(os.environ.get("AGENTD_DEV_CATALOG") or ROOT / "characters/sample-library/current.json")


def ids():
    return _DEV.ids()


def default():
    return _DEV.default()


def card_path(cid):
    return _DEV.card_path(cid)


def lore_path(cid):
    return _DEV.lore_path(cid)


def load_card(cid):
    return _DEV.load_card(cid)


def names():
    return _DEV.names()


def revision(cid):
    """First 12 hex digits of the card file's sha256."""
    return _DEV.revision(cid)


def _stamps(paths):
    """(st_ino, st_mtime_ns, st_size) of each path, None for a missing one."""
    result = []
    for path in paths:
        try:
            stat = path.stat()
            result.append((stat.st_ino, stat.st_mtime_ns, stat.st_size))
        except FileNotFoundError:
            result.append(None)
    return result


class Repository:
    """A server-scoped character library; without a catalog, the development sample library."""
    def __init__(self, catalog=None):
        # The one conversion: every library and package path below derives from it.
        self.catalog = Path(long_path(Path(catalog or DEV_CATALOG).resolve()))
        self._revision = None
        self._packages = {}
        self._verified = None  # (paths, stamps): the catalog, native bundle and definitions the last refresh hashed
        self._cards = {}  # card path -> (st_mtime_ns, parsed card)

    def _refresh(self):
        if self._verified is not None and _stamps(self._verified[0]) == self._verified[1]:
            return
        from character_library import Library, PackageError, contained, digest
        paths = [self.catalog]
        stamps = _stamps(paths)
        library = Library(self.catalog.parent, catalog_name=self.catalog.name)
        snapshot = library.snapshot()
        if snapshot["revision"] != self._revision:
            self._packages = {p.id: p for p in library.packages()}
            self._default = snapshot.get("default_character")  # a missing current.json has no characters
            self._revision = snapshot["revision"]
        if "native_bundle" in snapshot:
            paths.append(contained(library.root, snapshot["native_bundle"]["file"]))
            stamps += _stamps(paths[-1:])
        for p in self._packages.values():
            paths.append(p.root / "character.json")
            stamps += _stamps(paths[-1:])
            if digest(paths[-1]) != p.sha256:
                raise PackageError("definition_sha_mismatch")
        self._verified = (paths, stamps)

    def ids(self):
        self._refresh(); return sorted(self._packages)

    def default(self):
        self._refresh(); return self._default

    def package(self, cid):
        self._refresh()
        if cid not in self._packages: raise ValueError(f"unknown character {cid!r}")
        return self._packages[cid]

    def card_path(self, cid):
        return self.package(cid).resolve(self.package(cid).card_ref)

    def lore_path(self, cid):
        return self.package(cid).resolve(self.package(cid).lore_ref)

    def load_card(self, cid):
        """A copy of the parsed card, parsed again (and its sha256 checked again) only when its file changed."""
        package = self.package(cid)
        path = package.resolve(package.card_ref, verify=False)
        stamp = path.stat().st_mtime_ns
        cached = self._cards.get(path)
        if cached is None or cached[0] != stamp:
            package.resolve(package.card_ref)
            cached = self._cards[path] = (stamp, json.loads(path.read_text(encoding="utf-8")))
        return copy.deepcopy(cached[1])
    def names(self): return [self.load_card(cid)["name"] for cid in self.ids()]
    def revision(self, cid): return hashlib.sha256(self.card_path(cid).read_bytes()).hexdigest()[:12]
    def voice(self, cid):
        voice = self.package(cid).components.get("voice")
        return (voice["character"], voice["language"]) if voice else None


_DEV = Repository(DEV_CATALOG)
