"""VMD through the existing importer, its report mapped onto the unified import result."""
from pathlib import Path

from ..import_vmd import checked_vmd, import_motion
from ..mmd.io import last_frame
from .take import audio_track


def _checked(path):
    try: return checked_vmd(path)
    except ValueError as error: raise ValueError('bad_vmd: ' + str(error)) from error


def probe(path, take=0):
    v = _checked(path); end = last_frame(v)
    return {'takes': [{'index': 0, 'name': Path(path).name, 'duration_s': end / 30, 'frames': end + 1, 'frame_rate': 30.0}],
            'has_face': len(v.morphs) > 0, 'has_camera': len(v.cameras) > 0, 'warnings': []}


def import_file(package_root, path, output, *, title=None, bgm=None, bgm_start=None, foot_lock=True, camera: Path | None = None,
                progress=None):
    # Only these arguments, so the identity stays the one motion_tool's --vmd import gives.
    report = import_motion(package_root, path, output, title=title, bgm=bgm, bgm_start=bgm_start, foot_ik=foot_lock, camera=camera,
                           progress=progress)
    return parts(report, path, title)


def _track(doc, keys):
    """The report's face or camera without its diagnostics; the import result carries none."""
    return None if doc is None else {k: doc[k] for k in keys}


def parts(report, path, title):
    """take.build_result's format, action, source, tracks and warnings for an import_motion report."""
    action = {'id': report['action'], 'clip': report['clip'], 'title': title, 'duration_s': report['duration'],
              'frames': report['frames'], 'has_bgm': report['bgm'] is not None}
    source = {'name': Path(path).name, 'sha256': report['provenance']['vmd_sha256'], 'take': 0, 'takes': 1,
              'frame_rate': 30.0, 'frames': last_frame(checked_vmd(path)) + 1, 'zip': None, 'expressions': []}
    tracks = {'body': {'retarget': 'mmd-vmd', 'unmapped': [], 'fingers': 'retargeted',
                       'foot_lock': report['provenance']['foot_ik'], 'coverage': report['coverage']},
              'face': _track(report.get('face'), ('facial_animation', 'file', 'mapping', 'mapped', 'unmapped', 'applied')),
              'camera': _track(report.get('camera'), ('file', 'source_sha256', 'frames', 'cuts', 'perspective',
                                                      'coordinate_boundary', 'applied')),
              'audio': audio_track(report['bgm'], report['action'][len('mmd_'):])}
    return {'format': 'vmd', 'action': action, 'source': source, 'tracks': tracks, 'warnings': []}
