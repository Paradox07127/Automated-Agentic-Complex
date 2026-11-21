"""Which format a motion source is, by content first and suffix last, and the loader module for it."""
import importlib
import json
from pathlib import Path
import struct

from .take import FORMATS

SUFFIXES = {'.vmd': 'vmd', '.bvh': 'bvh', '.glb': 'gltf', '.gltf': 'gltf', '.vrma': 'vrma', '.fbx': 'fbx', '.zip': 'zip'}
JSON_LIMIT = 256 * 1024**2


def _gltf_kind(document):
    used = document.get('extensionsUsed')
    return 'vrma' if isinstance(used, list) and 'VRMC_vrm_animation' in used else 'gltf'


def _glb_json(path, head):
    """The JSON chunk of a GLB, or None when the header is not GLB 2 with a JSON first chunk."""
    if len(head) < 20: return None
    version, = struct.unpack_from('<I', head, 4); length, = struct.unpack_from('<I', head, 12)
    if version != 2 or head[16:20] != b'JSON' or length > JSON_LIMIT: return None
    with Path(path).open('rb') as file:
        file.seek(20); chunk = file.read(length)
    try: document = json.loads(chunk)
    except ValueError: return None
    return document if isinstance(document, dict) else None


def _json(path):
    if Path(path).stat().st_size > JSON_LIMIT: return None
    try: document = json.loads(Path(path).read_bytes())
    except ValueError: return None
    return document if isinstance(document, dict) and 'asset' in document else None


def detect(path):
    with Path(path).open('rb') as file:
        head = file.read(64 * 1024)
    if head.startswith(b'Vocaloid Motion Data'): return 'vmd'
    if head[:4] == b'glTF':
        document = _glb_json(path, head)
        if document is not None: return _gltf_kind(document)
    if head.startswith(b'PK\x03\x04'): return 'zip'
    if head.startswith(b'Kaydara FBX Binary'): return 'fbx'
    text = head.lstrip()
    if text.startswith(b'HIERARCHY'): return 'bvh'
    if text.startswith(b'; FBX'): return 'fbx'
    if text.startswith(b'{'):
        document = _json(path)
        if document is not None: return _gltf_kind(document)
    fmt = SUFFIXES.get(Path(path).suffix.lower())
    if fmt is None: raise ValueError('unsupported_format')
    return fmt


def importer(fmt):
    if fmt not in FORMATS: raise ValueError('unsupported_format')
    try: return importlib.import_module('.' + fmt, __package__)
    except ModuleNotFoundError as error:
        if error.name == __package__ + '.' + fmt: raise ValueError('unsupported_format: ' + fmt) from error
        raise
