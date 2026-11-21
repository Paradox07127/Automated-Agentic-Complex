"""The in-memory take every format loader produces, its resampling, and the import result, report and index documents."""
from dataclasses import dataclass, field, replace
import math

import numpy as np

from ..mmd import rotation

RESULT_SCHEMA = 'endfield-motion-import/v1'
INDEX_SCHEMA = 'endfield-motion-imports/v2'
FORMATS = ('vmd', 'bvh', 'gltf', 'vrma', 'fbx', 'zip')
FPS = 30
MAX_SECONDS = 180
REASONS = ('validate_failed', 'too_many_actions', 'too_many_media', 'bad_vmd', 'too_long', 'missing_bones', 'busy', 'internal',
           'unsupported_format', 'bad_source', 'no_animation', 'unmapped_skeleton', 'already_imported', 'unknown_action',
           'not_imported', 'bad_title', 'bad_zip', 'ambiguous_motion')
# synthesized_bones comes as 'synthesized_bones: <canonical joints, comma-separated>'.
WARNINGS = ('fingers_rest', 'toe_synthesized', 'hand_tip_synthesized', 'shoulder_synthesized', 'scale_ignored',
            'translation_ignored', 'expression_clamped', 'expressions_not_applied', 'look_at_ignored', 'unmapped_bones',
            'synthesized_bones')

# The SOMA-style joints mmd.rig_math.Retarget reads, in MmdSource's order.
CANONICAL = ('Hips', 'Spine1', 'Spine2', 'Chest', 'Neck1', 'Head',
             'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'LeftHandTip',
             'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'RightHandTip',
             'LeftLeg', 'LeftShin', 'LeftFoot', 'LeftToeBase',
             'RightLeg', 'RightShin', 'RightFoot', 'RightToeBase')
CANONICAL_PARENTS = (-1, 0, 1, 2, 3, 4,
                     3, 6, 7, 8, 9,
                     3, 11, 12, 13, 14,
                     0, 16, 17, 18,
                     0, 20, 21, 22)


@dataclass(frozen=True)
class Expression:
    name: str
    weights: np.ndarray  # (F,), 0-1


@dataclass
class MotionTake:
    """One source take on the canonical joints: positions and global rotations relative to the neutral pose."""
    format: str
    source_name: str
    source_sha256: str
    frame_rate: float
    neutral: np.ndarray  # (J, 3)
    xyz: np.ndarray  # (F, J, 3)
    R: np.ndarray  # (F, J, 3, 3)
    take: int = 0
    takes: int = 1
    source_frames: int = 0
    fingers: object = None
    contacts: np.ndarray = None  # (F, 2) bool: left, right
    expressions: tuple = ()
    unmapped: list = field(default_factory=list)
    warnings: list = field(default_factory=list)

    @property
    def duration_s(self):
        return (len(self.xyz) - 1) / self.frame_rate

    def validate(self):
        J = len(CANONICAL); F = len(self.xyz) if np.ndim(self.xyz) else -1
        shaped = (np.shape(self.neutral) == (J, 3) and np.shape(self.xyz) == (F, J, 3) and np.shape(self.R) == (F, J, 3, 3)
                  and (self.contacts is None or np.shape(self.contacts) == (F, 2) and np.asarray(self.contacts).dtype == bool)
                  and all(np.shape(e.weights) == (F,) for e in self.expressions))
        if not shaped or self.frame_rate <= 0: raise ValueError('invalid_take_shape')
        arrays = [self.neutral, self.xyz, self.R, self.frame_rate, *(e.weights for e in self.expressions)]
        if not all(np.isfinite(a).all() for a in arrays): raise ValueError('nonfinite_take')
        if F < 2: raise ValueError('no_animation')
        if self.duration_s > MAX_SECONDS: raise ValueError('too_long')

    def skeleton(self):
        return {'names': list(CANONICAL), 'parents': list(CANONICAL_PARENTS), 'neutral_joints': np.asarray(self.neutral, float).tolist()}


def resample(take, fps=FPS):
    count = math.floor(take.duration_s * fps + 1e-9) + 1
    F = len(take.xyz)
    s = np.arange(count) * (take.frame_rate / fps)  # source frame of each output frame
    i = np.clip(np.floor(s).astype(int), 0, F - 2); w = np.clip(s - i, 0, 1)

    def lerp(values):
        values = np.asarray(values, float); weight = w.reshape((-1,) + (1,) * (values.ndim - 1))
        return values[i] * (1 - weight) + values[i + 1] * weight
    R = np.asarray(take.R, float)
    contacts = None if take.contacts is None else np.asarray(take.contacts)[np.clip(np.rint(s).astype(int), 0, F - 1)]
    return replace(take, frame_rate=fps, xyz=lerp(take.xyz), R=rotation.slerp(R[i], R[i + 1], w[:, None, None]),
                   contacts=contacts, expressions=tuple(Expression(e.name, lerp(e.weights)) for e in take.expressions),
                   unmapped=list(take.unmapped), warnings=list(take.warnings))


def audio_track(music_info, identity):
    """tracks.audio from import_vmd.prepare_music's return."""
    if music_info is None: return None
    return {'file': 'animation/music/' + identity + '.wav', 'source_sha256': music_info['source_sha256'],
            'offset_s': music_info['source_start_seconds'], 'padded_frames': music_info['padded_frames'],
            'sample_rate': music_info['sample_rate'], 'channels': 2,
            'length_s': music_info['frames'] / music_info['sample_rate'], 'rate': 1.0}


def _playback(tracks, playback):
    if playback is not None: return playback
    return {'speeds': [1], 'loop': False} if tracks['audio'] else {'speeds': [0.5, 1, 2], 'loop': False}


def report_document(*, character, format, action, source, tracks, warnings, playback=None):
    """The package's provenance report: the import result without ok, version and created_at."""
    return {'schema': RESULT_SCHEMA, 'character': character, 'format': format, 'action': action, 'source': source,
            'tracks': tracks, 'playback': _playback(tracks, playback), 'warnings': warnings}


def build_result(*, character, version, created_at, format, action, source, tracks, warnings, playback=None):
    return {'schema': RESULT_SCHEMA, 'ok': True, 'character': character, 'version': version, 'format': format,
            'action': action, 'source': source, 'tracks': tracks, 'playback': _playback(tracks, playback),
            'warnings': warnings, 'created_at': created_at}


def _string(x): return isinstance(x, str)
def _optional_string(x): return x is None or isinstance(x, str)
def _int(x): return isinstance(x, int) and not isinstance(x, bool)
def _number(x): return isinstance(x, (int, float)) and not isinstance(x, bool)
def _bool(x): return isinstance(x, bool)
def _object(x): return isinstance(x, dict)
def _optional_object(x): return x is None or isinstance(x, dict)
def _strings(x): return isinstance(x, list) and all(map(_string, x))
def _any(x): return True


def _check(kind, path, doc, spec, optional=None):
    """doc has exactly spec's keys plus any of optional's, each passing its test; the error names the first key that does not."""
    if not isinstance(doc, dict): raise ValueError('invalid_%s: %s' % (kind, path or 'document'))
    allowed = dict(spec, **(optional or {}))
    for key in [*spec, *doc]:
        if key not in doc or key not in allowed or not allowed[key](doc[key]):
            raise ValueError('invalid_%s: %s' % (kind, path + '.' + key if path else key))


_ACTION = dict(id=_string, clip=_string, title=_string, duration_s=_number, frames=_int, has_bgm=_bool)
_SOURCE = dict(name=_string, sha256=_string, take=_int, takes=_int, frame_rate=_number, frames=_int, zip=_optional_object,
               expressions=_strings)
_TRACKS = dict(body=_object, face=_optional_object, camera=_optional_object, audio=_optional_object)
_BODY = dict(retarget=lambda x: x in ('mmd-vmd', 'humanoid-bone-direction'), unmapped=_strings,
             fingers=lambda x: x in ('rest', 'retargeted'), foot_lock=_bool)
_FACE = dict(facial_animation=_string, file=_string, mapping=lambda x: x in ('package', 'default'), mapped=_strings,
             unmapped=_strings, applied=_bool)
_CAMERA = dict(file=_string, source_sha256=_string, frames=_int, cuts=lambda x: isinstance(x, list) and all(map(_int, x)),
               perspective=_bool, coordinate_boundary=_string, applied=_bool)
_AUDIO = dict(file=_string, source_sha256=_string, offset_s=_number, padded_frames=_int, sample_rate=_int, channels=_int,
              length_s=_number, rate=_number)
# Report-only diagnostics motion-mmd may add to face and camera.
_DIAGNOSTICS = dict(controls=_any, keys=_any, tolerance=_any)
_PLAYBACK = dict(speeds=lambda x: isinstance(x, list) and all(map(_number, x)), loop=_bool)


def check_result(doc, report=False):
    shell = dict(schema=lambda x: x == RESULT_SCHEMA, character=_string, format=lambda x: x in FORMATS, action=_object,
                 source=_object, tracks=_object, playback=_object, warnings=_strings)
    if not report: shell.update(ok=lambda x: x is True, version=_string, created_at=_string)
    _check('result', '', doc, shell)
    _check('result', 'action', doc['action'], _ACTION)
    _check('result', 'source', doc['source'], _SOURCE)
    tracks = doc['tracks']
    _check('result', 'tracks', tracks, _TRACKS)
    _check('result', 'tracks.body', tracks['body'], _BODY, dict(coverage=_object))
    for name, spec in (('face', _FACE), ('camera', _CAMERA), ('audio', _AUDIO)):
        if tracks[name] is not None:
            _check('result', 'tracks.' + name, tracks[name], spec, _DIAGNOSTICS if report and name != 'audio' else None)
    _check('result', 'playback', doc['playback'], _PLAYBACK)


_ENTRY = dict(action=_optional_string, clip=_optional_string, format=lambda x: x in FORMATS, title=_string, source=_object,
              bgm=_optional_object, camera=_optional_object, zip=_optional_object, morphs_mapped=_strings,
              morphs_unmapped=_strings, created_at=_string, removed_at=_optional_string)
_FILES = dict(source=dict(file=_string, sha256=_string, name=_optional_string),
              bgm=dict(file=_string, sha256=_string, offset_s=lambda x: x is None or _number(x)),
              camera=dict(file=_string, sha256=_string, name=_string),
              zip=dict(file=_string, sha256=_string, name=_string))


def check_index(doc):
    _check('index', '', doc, dict(schema=lambda x: x == INDEX_SCHEMA, imports=lambda x: isinstance(x, list)))
    for n, entry in enumerate(doc['imports']):
        path = 'imports[%d]' % n
        _check('index', path, entry, _ENTRY)
        for key, spec in _FILES.items():
            if entry[key] is not None: _check('index', path + '.' + key, entry[key], spec)


def check_mmd_index(doc):
    _check('index', '', doc, dict(schema=lambda x: x == 'endfield-mmd-library/v1', entries=lambda x: isinstance(x, list)))
    spec = dict(id=_string, title=_string, duration_s=_number, created_at=_string, removed_at=_optional_string,
                source=_object, camera=_optional_object, bgm=_optional_object, zip=_optional_object, failures=_object)
    for n, entry in enumerate(doc['entries']):
        path = 'entries[%d]' % n
        _check('index', path, entry, spec)
        for key, fields in _FILES.items():
            if entry[key] is not None: _check('index', path + '.' + key, entry[key], fields)
        for character, failure in entry['failures'].items():
            _check('index', path + '.failures.' + character, failure, dict(reason=_string, detail=_string, package_sha256=_string))
