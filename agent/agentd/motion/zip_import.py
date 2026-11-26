"""A motion ZIP unpacked safely, a dropped folder walked, and MMD import inputs sorted into bodies, faces, cameras and audio by content."""
import os
from pathlib import Path
import re
import zipfile
import zlib

from character_library import PackageError, safe_extract_zip

MAX_ZIP_BYTES = 512 * 1024 ** 2
# For one ZIP or one folder.
MAX_FILES = 256
MAX_BYTES = 1024 ** 3
AUDIO = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".aif", ".aiff"}
FPS = 30
# A trailing [fN] places the motion at frame N of the song.
PLACE = re.compile(r"\[f(-?\d+)\]$")
SEPARATORS = "_ -."


class Failure(Exception):
    def __init__(self, reason, detail):
        super().__init__(str(detail)); self.reason = reason


def fail(reason, detail): raise Failure(reason, detail)


def skipped(name):
    """macOS resource forks and hidden files are never motion inputs."""
    parts = name.split("/")
    return parts[0] == "__MACOSX" or any(part.startswith(".") for part in parts)


def extract(zip_path: Path, dest: Path) -> list[Path]:
    try:
        if Path(zip_path).stat().st_size > MAX_ZIP_BYTES: fail("bad_zip", "the ZIP is over %d MiB" % (MAX_ZIP_BYTES // 1024 ** 2))
        return safe_extract_zip(Path(zip_path), Path(dest), max_files=MAX_FILES, max_bytes=MAX_BYTES, decode_cp932=True, skip=skipped)
    except (PackageError, zipfile.BadZipFile, zlib.error, EOFError, OSError) as error: fail("bad_zip", error)


def walk(folder: Path) -> list[Path]:
    """The files below folder, sorted, leaving out hidden entries and __MACOSX; bad_source when a link or junction is among them."""
    files, total = [], 0
    for top, dirs, names in os.walk(folder):
        dirs[:] = [d for d in dirs if not (d.startswith(".") or d == "__MACOSX")]
        names = [name for name in names if not name.startswith(".")]
        for name in dirs + names:
            path = Path(top) / name
            # A Windows junction is no symlink to islink.
            if os.path.islink(path) or os.path.isjunction(path): fail("bad_source", "%s is a link" % path)
        for name in names:
            path = Path(top) / name
            files.append(path); total += path.stat().st_size
            if len(files) > MAX_FILES: fail("bad_source", "%s holds more than %d files" % (folder, MAX_FILES))
            if total > MAX_BYTES: fail("bad_source", "%s holds more than %d GiB" % (folder, MAX_BYTES // 1024 ** 3))
    return sorted(files)


def placed(path):
    """The stem without a trailing [fN], and N or None."""
    match = PLACE.search(path.stem)
    return (path.stem[:match.start()], int(match.group(1))) if match else (path.stem, None)


def labels(stems):
    """Each stem's part that differs from the others' once their common prefix and suffix, cut back to a separator, are
    removed; the whole stem when there is one or nothing differs."""
    if len(stems) < 2: return list(stems)
    prefix = os.path.commonprefix(stems)
    prefix = prefix[:max(prefix.rfind(c) for c in SEPARATORS) + 1]
    rests = [stem[len(prefix):] for stem in stems]
    suffix = os.path.commonprefix([rest[::-1] for rest in rests])[::-1]
    suffix = suffix[min((i for i, c in enumerate(suffix) if c in SEPARATORS), default=len(suffix)):]
    return [rest[:len(rest) - len(suffix)].strip(SEPARATORS) or stem for rest, stem in zip(rests, stems)]


def classify(paths, read) -> dict:
    """mmd-scan's bodies, faces, cameras, audio, ignored and suggested for these files.
    read(path) -> dict(bones, cameras, morphs (distinct names), model, frames (last frame)); ValueError when it does not parse."""
    bodies, faces, cameras, audio, ignored = [], [], [], [], []
    for path in paths:
        suffix = path.suffix.lower()
        if suffix in AUDIO: audio.append(dict(path=str(path), name=path.name)); continue
        if suffix != ".vmd": ignored.append(dict(name=path.name, reason="not_motion")); continue
        try: info = read(path)
        except ValueError: ignored.append(dict(name=path.name, reason="bad_vmd")); continue
        item = dict(path=str(path), name=path.name)
        if info["bones"]:
            bodies.append(dict(item, label=placed(path)[0], model=info["model"], duration_s=info["frames"] / FPS,
                               place_frame=placed(path)[1], has_morph=info["morphs"] > 0))
        elif info["cameras"]: cameras.append(dict(item, duration_s=info["frames"] / FPS, place_frame=placed(path)[1]))
        elif info["morphs"]: faces.append(dict(item, duration_s=info["frames"] / FPS, morphs=info["morphs"]))
        else: ignored.append(dict(name=path.name, reason="no_keys"))
    if not bodies: fail("bad_vmd", "no body motion")
    for found in (bodies, faces, cameras, audio, ignored): found.sort(key=lambda x: x["name"])
    for body, label in zip(bodies, labels([body["label"] for body in bodies])): body["label"] = label
    longest = lambda found: max(range(len(found)), key=lambda i: found[i]["duration_s"]) if found else None
    body = longest(bodies)
    face = 0 if len(faces) == 1 else next((i for i, f in enumerate(faces) if bodies[body]["label"] in Path(f["name"]).stem), None)
    frame = bodies[body]["place_frame"]
    return dict(bodies=bodies, faces=faces, cameras=cameras, audio=audio, ignored=ignored,
                suggested=dict(body=body, face=face, camera=longest(cameras), audio=0 if audio else None,
                               bgm_start_s=round(frame / FPS, 3) if frame is not None else None))
