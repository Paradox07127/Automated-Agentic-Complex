"""The one entry point motion_tool and build.py import a motion source through, whatever its format."""
from pathlib import Path

from . import formats, vmd


def probe_file(path, fmt='auto', take=0):
    if fmt == 'auto': fmt = formats.detect(path)
    return dict(format=fmt, **formats.importer(fmt).probe(path, take))


def import_file(package_root, path, fmt, output, *, take=0, title=None, bgm=None, bgm_start=None, foot_lock=True,
                bone_map=None, camera: Path | None = None, morph: Path | None = None, progress=None, identity=None):
    """The import result's parts (take.build_result's arguments but character, version, created_at and playback).
    progress(stage, fraction): import_motion's stages for a VMD, import_take's for the other formats. identity: a VMD's
    action id without its mmd_ prefix, in place of the hash of its inputs."""
    if fmt == 'auto': fmt = formats.detect(path)
    if title is None: title = Path(path).stem
    if fmt == 'vmd':
        if take != 0: raise ValueError('bad_source: take')
        return vmd.import_file(package_root, path, output, title=title, bgm=bgm, bgm_start=bgm_start, foot_lock=foot_lock,
                               camera=camera, morph=morph, progress=progress, identity=identity)
    if camera is not None or morph is not None: raise ValueError('bad_source: a camera or face VMD goes only with a VMD body motion')
    module = formats.importer(fmt)
    motion = module.load(path, take, {'bone_map': bone_map})
    try: from .bake import import_take
    except ModuleNotFoundError as error:
        if error.name.endswith('.bake'): raise ValueError('unsupported_format: bake') from error
        raise
    return import_take(package_root, motion, output, title=title, bgm=bgm, bgm_start=bgm_start, foot_lock=foot_lock,
                       bone_map=bone_map, progress=progress)
