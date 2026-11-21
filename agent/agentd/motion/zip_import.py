"""A motion ZIP unpacked safely, and import inputs sorted into one body VMD, camera VMD and audio file by content."""
from pathlib import Path
import zipfile
import zlib

from character_library import PackageError, safe_extract_zip

MAX_ZIP_BYTES = 128 * 1024 ** 2
AUDIO = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".aif", ".aiff"}


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
        return safe_extract_zip(Path(zip_path), Path(dest), max_files=64, max_bytes=512 * 1024 ** 2, decode_cp932=True, skip=skipped)
    except (PackageError, zipfile.BadZipFile, zlib.error, EOFError, OSError) as error: fail("bad_zip", error)


def classify(paths, vmd_counts) -> dict:
    """vmd_counts(path) -> (bone frames, camera frames); body, camera and audio are one path or None, the rest go to warnings."""
    bodies, cameras, audio, warnings = [], [], [], []
    for path in paths:
        suffix = path.suffix.lower()
        bones, frames = vmd_counts(path) if suffix == ".vmd" else (0, 0)
        if bones > 0: bodies.append(path)
        elif frames > 0: cameras.append(path)
        elif suffix in AUDIO: audio.append(path)
        else: warnings.append("ignored_file: " + path.name)
    for found in (bodies, cameras, audio):
        if len(found) > 1: fail("ambiguous_motion", ",".join(p.name for p in found))
    if not bodies: fail("bad_vmd", "no body motion")
    return dict(body=bodies[0], camera=cameras[0] if cameras else None, audio=audio[0] if audio else None, warnings=warnings)
