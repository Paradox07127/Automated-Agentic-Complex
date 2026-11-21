"""Lossless EFKEY001 <-> EFKEY002 conversion for baked actor clip keys.

EFKEY002 keeps only what EFKEY001 keys carry beyond derivable data: values, plus
frame indices or times where the curve is not on the clip's frame grid. Tangents
are the linear slopes between keys, or else one stored f32 per segment (key k's out
tangent is key k+1's in tangent; end tangents zero); weights one per file, weighted
mode 0.

Layout (little endian):
  header 40 B: magic 'EFKEY002', codec u32 (0 raw, 1 LZFSE), frame_count u32,
    frame_rate f32, length f32, curve_count u32, payload bytes u32 (decoded),
    in_weight f32, out_weight f32
  curve table 16 B each, in the clip JSON's curve order: node u16, attribute u8
    (0 position, 1 rotation, 2 scale), component u8, kind u8, 3 zero bytes,
    count u32, payload offset u32
  payload, curve-major: const -> 1 f32 (time 0); uniform -> frame_count f32 at
    float32(k / frame_rate); sparse -> u16 frame[count] + f32[count];
    explicit -> f32 time[count] + f32[count]; kinds 4-6 are kinds 1-3 followed by
    f32 tangent[count-1], the bit-exact EFKEY001 tangents of each segment

Usage: python3 -I keys_v2.py --check <dir> [--lzfse]
"""
from collections import Counter
import ctypes
import json
from pathlib import Path
import struct
import sys

import numpy as np

MAGIC1, MAGIC2 = b'EFKEY001', b'EFKEY002'
KEY = np.dtype([('t', '<f4'), ('v', '<f4'), ('i', '<f4'), ('o', '<f4'), ('wi', '<f4'), ('wo', '<f4'), ('m', '<u4')])
HEADER = struct.Struct('<8sIIffIIff')
ENTRY = struct.Struct('<HBBB3xII')
ATTRIBUTES = ('position', 'rotation', 'scale')
CONST, UNIFORM, SPARSE, EXPLICIT = range(4)
TANGENTS = 3
RAW, LZFSE = 0, 1
_LZFSE_ALGORITHM = 0x801


def _libcompression():
    try:
        lib = ctypes.CDLL('/usr/lib/libcompression.dylib')
    except OSError:
        return None
    for name in ['compression_encode_buffer', 'compression_decode_buffer']:
        function = getattr(lib, name)
        function.restype = ctypes.c_size_t
        function.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_int]
    return lib


_LIB = _libcompression()


def lzfse_available():
    return _LIB is not None


def _lzfse(function, data, capacity):
    source = ctypes.create_string_buffer(bytes(data), len(data))
    target = ctypes.create_string_buffer(capacity)
    size = function(target, capacity, source, len(data), None, _LZFSE_ALGORITHM)
    return target.raw[:size]


def _slopes(t, v):
    """Matches the writers: float32 keys, slope in double, rounded to float32."""
    t, v = t.astype(np.float64), v.astype(np.float64)
    return ((v[1:]-v[:-1])/(t[1:]-t[:-1])).astype(np.float32)


def _ordered(values):
    bits = values.astype(np.float32).view(np.int32).astype(np.int64)
    return np.where(bits < 0, -(bits & 0x7fffffff), bits)


def _ulps(a, b):
    return np.abs(_ordered(a)-_ordered(b))


def _bits(values):
    return values.astype(np.float32).view(np.uint32)


def _need(ok, message):
    if not ok:
        raise ValueError(message)


def encode(efkey001, clip, lzfse=False):
    """`clip` is the clip JSON (frame_rate, length and the curve table)."""
    _need(efkey001[:8] == MAGIC1 and (len(efkey001)-8) % 28 == 0, 'not an EFKEY001 payload')
    keys = np.frombuffer(efkey001, KEY, offset=8)
    rate = np.float32(clip['frame_rate'])
    fr = float(rate)
    _need(np.isfinite(rate) and rate > 0, 'invalid frame rate')
    _need(not len(keys) or (np.all(keys['m'] == 0) and np.all(_bits(keys['wi']) == _bits(keys['wi'][:1]))
                            and np.all(_bits(keys['wo']) == _bits(keys['wo'][:1]))), 'keys carry weighted tangents')
    weights = (keys['wi'][0], keys['wo'][0]) if len(keys) else (np.float32(1/3), np.float32(1/3))
    rows, offset = [], 8
    for c in clip['curves']:
        count = c['count']
        _need(c['stride'] == 28 and c['offset'] == offset and count > 0, 'curve table does not tile the key payload in order')
        _need(c['attribute'] in ATTRIBUTES and 0 <= c['node'] <= 0xffff and 0 <= c['component'] <= 3, 'curve target out of range')
        k = keys[(offset-8)//28:(offset-8)//28+count]
        offset += 28*count
        name = '%s/%s/%s' % (c['node'], c['attribute'], c['component'])
        t, v = k['t'], k['v']
        _need(np.all(np.isfinite(t)) and np.all(np.isfinite(v)) and np.all(np.diff(t.astype(np.float64)) > 0)
              and not np.any(np.isnan(k['i'])) and not np.any(np.isnan(k['o'])), name+': malformed keys')
        _need(_bits(k['i'][:1])[0] == 0 and _bits(k['o'][-1:])[0] == 0, name+': end tangents are not zero')
        tangents = None
        if count > 1:
            s = _slopes(t, v)
            exact = np.array_equal(_bits(s), _bits(k['i'][1:])) and np.array_equal(_bits(s), _bits(k['o'][:-1]))
            if not exact and np.array_equal(_bits(k['i'][1:]), _bits(k['o'][:-1])):
                tangents = k['o'][:-1]
            elif not exact:
                # In and out tangents differ per segment: only the recomputed slope fits, so accept it within 1 ulp.
                _need(int(max(_ulps(s, k['i'][1:]).max(), _ulps(s, k['o'][:-1]).max())) <= 1,
                      name+': tangents are neither the linear slopes nor one per segment')
        frames = np.rint(t.astype(np.float64)*fr).astype(np.int64)
        on_grid = bool(frames[0] >= 0 and np.array_equal(_bits((frames/fr).astype(np.float32)), _bits(t)))
        rows.append((c, t, v, frames, on_grid, tangents))
    _need(offset == len(efkey001), 'key payload has bytes outside the curve table')
    frame_count = max([int(f[-1])+1 for _, t, _, f, grid, _ in rows if grid and len(t) > 1], default=0)
    table, payload = [], []
    size = 0
    for c, t, v, frames, on_grid, tangents in rows:
        count = len(t)
        if count == 1 and _bits(t)[0] == 0:
            kind, data = CONST, [v.tobytes()]
        elif count > 1 and on_grid and count == frame_count and np.array_equal(frames, np.arange(count)):
            kind, data = UNIFORM, [v.tobytes()]
        elif count > 1 and on_grid and frames[-1] <= 0xffff:
            kind, data = SPARSE, [frames.astype('<u2').tobytes(), v.tobytes()]
        else:
            kind, data = EXPLICIT, [t.tobytes(), v.tobytes()]
        if tangents is not None:
            kind, data = kind+TANGENTS, data+[tangents.tobytes()]
        table.append(ENTRY.pack(c['node'], ATTRIBUTES.index(c['attribute']), c['component'], kind, count, size))
        payload += data
        size += sum(len(d) for d in data)
    payload = b''.join(payload)
    codec, stored = RAW, payload
    if lzfse and payload and lzfse_available():
        packed = _lzfse(_LIB.compression_encode_buffer, payload, len(payload)+len(payload)//4+65536)
        if packed:
            codec, stored = LZFSE, packed
    header = HEADER.pack(MAGIC2, codec, frame_count, rate, np.float32(clip['length']), len(rows), len(payload), *weights)
    return header+b''.join(table)+stored


def decode(efkey002):
    """Rebuild the EFKEY001 bytes the clip JSON's curve offsets refer to."""
    _need(len(efkey002) >= HEADER.size and efkey002[:8] == MAGIC2, 'not an EFKEY002 payload')
    _, codec, frame_count, rate, _, count, raw_bytes, in_weight, out_weight = HEADER.unpack_from(efkey002)
    end = HEADER.size+ENTRY.size*count
    _need(codec in (RAW, LZFSE) and len(efkey002) >= end, 'invalid EFKEY002 header')
    if codec == RAW:
        payload = efkey002[end:]
    else:
        _need(lzfse_available(), 'LZFSE is unavailable')
        payload = _lzfse(_LIB.compression_decode_buffer, efkey002[end:], raw_bytes+1)
    _need(len(payload) == raw_bytes, 'payload size disagrees with the header')
    fr, out, size = float(rate), [MAGIC1], 0
    for index in range(count):
        _, _, _, kind, n, offset = ENTRY.unpack_from(efkey002, HEADER.size+ENTRY.size*index)
        layout = kind-TANGENTS if kind > EXPLICIT else kind
        _need(offset == size and kind <= EXPLICIT+TANGENTS and n > 0 and (kind != CONST or n == 1) and (layout != UNIFORM or n == frame_count)
              and (kind <= EXPLICIT or n > 1), 'invalid curve table entry')
        if layout == CONST:
            t, v = np.zeros(1, np.float32), np.frombuffer(payload, '<f4', 1, offset)
        elif layout == UNIFORM:
            t, v = (np.arange(n)/fr).astype(np.float32), np.frombuffer(payload, '<f4', n, offset)
        elif layout == SPARSE:
            t, v = (np.frombuffer(payload, '<u2', n, offset)/fr).astype(np.float32), np.frombuffer(payload, '<f4', n, offset+2*n)
        else:
            t, v = np.frombuffer(payload, '<f4', n, offset), np.frombuffer(payload, '<f4', n, offset+4*n)
        size = offset+[4, 4*n, 6*n, 8*n][layout]
        keys = np.zeros(n, KEY)
        keys['t'], keys['v'], keys['wi'], keys['wo'] = t, v, in_weight, out_weight
        if n > 1:
            s = _slopes(t, v) if kind <= EXPLICIT else np.frombuffer(payload, '<f4', n-1, size)
            keys['i'][1:], keys['o'][:-1] = s, s
            size += 0 if kind <= EXPLICIT else 4*(n-1)
        out.append(keys.tobytes())
    _need(size == raw_bytes, 'payload has bytes outside the curve table')
    return b''.join(out)


def same_keys(a, b):
    """Bit-identical keys, except tangents may differ by one float32 ulp."""
    if a == b:
        return True
    if len(a) != len(b) or a[:8] != b[:8] or (len(a)-8) % 28:
        return False
    x, y = np.frombuffer(a, KEY, offset=8), np.frombuffer(b, KEY, offset=8)
    return all(np.array_equal(x[f].view(np.uint32), y[f].view(np.uint32)) for f in ['t', 'v', 'wi', 'wo', 'm']) \
        and int(max(_ulps(x['i'], y['i']).max(), _ulps(x['o'], y['o']).max())) <= 1


def check(directory, lzfse=False):
    """Round-trip every *.keys under `directory`; reads only."""
    root = Path(directory)
    clips = {}
    for path in sorted(root.rglob('*.json')):
        clip = json.loads(path.read_text())
        if isinstance(clip, dict) and 'keys' in clip and 'curves' in clip and not clip.get('source_time_range'):
            clips[path.parent/Path(clip['keys']['file']).name] = clip
    count = before = after = mismatches = 0
    refused = Counter()
    for path in sorted(root.rglob('*.keys')):
        data = path.read_bytes()
        count += 1
        before += len(data)
        try:
            _need(path in clips, 'no clip JSON names this key file')
            packed = encode(data, clips[path], lzfse)
        except ValueError as error:
            refused[str(error).split(': ')[-1]] += 1
            after += len(data)
            continue
        after += len(packed)
        mismatches += not same_keys(decode(packed), data)
    return count, before, after, mismatches, refused


def main(argv):
    if len(argv) not in (2, 3) or argv[0] != '--check' or argv[2:] not in ([], ['--lzfse']):
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    lzfse = argv[2:] == ['--lzfse']
    if lzfse and not lzfse_available():
        print('LZFSE unavailable: writing codec 0', file=sys.stderr)
    count, before, after, mismatches, refused = check(argv[1], lzfse)
    print('%d clips, %d -> %d, %d mismatches' % (count, before, after, mismatches))
    if refused:
        print('%d clips not encodable, kept as EFKEY001 in the total: %s' % (sum(refused.values()), dict(refused)))
    return 1 if mismatches or refused else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
