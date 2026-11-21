#!/usr/bin/env python3
"""The icon and version resource of a Windows executable, written with kernel32's BeginUpdateResource/UpdateResource.

  python windows_exe.py ico <AppIcon-1024.png> <out.ico>   the .ico brand() embeds, for a look at it
icon() derives the PNG-in-ICO images from the UI art's square RGBA brand/AppIcon-1024.png, the source of the macOS
AppIcon.icns, in pure Python; brand() replaces every RT_ICON, RT_GROUP_ICON and RT_VERSION of the exe (the group keeps
Electron's name, which its windows load) and reads them back.
"""
import ctypes
import struct
import sys
import zlib

ICON_SIZES = (256, 64, 48, 32, 24, 16)
RT_ICON, RT_GROUP_ICON, RT_VERSION = 3, 14, 16
LOAD_LIBRARY_AS_DATAFILE = 0x2
# English (US), Unicode: the StringFileInfo table Explorer reads.
VERSION_LANG, VERSION_CODEPAGE = 0x0409, 1200


def _chunks(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n': raise ValueError('not a PNG')
    at = 8
    while at < len(data):
        length, kind = struct.unpack('>I4s', data[at:at + 8])
        yield kind, data[at + 8:at + 8 + length]
        at += 12 + length


def read_png(data):
    """(width, height, rows of RGBA bytes) of an 8-bit RGBA, non-interlaced PNG."""
    header, idat = None, b''
    for kind, body in _chunks(data):
        if kind == b'IHDR': header = struct.unpack('>IIBBBBB', body)
        elif kind == b'IDAT': idat += body
    width, height, depth, color, _, _, interlace = header
    if (depth, color, interlace) != (8, 6, 0): raise ValueError('icon source must be an 8-bit RGBA PNG without interlacing')
    raw, stride, rows, previous = zlib.decompress(idat), width * 4, [], bytearray(width * 4)
    for y in range(height):
        kind, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        if kind == 1:
            for i in range(4, stride): line[i] = (line[i] + line[i - 4]) & 255
        elif kind == 2:
            for i in range(stride): line[i] = (line[i] + previous[i]) & 255
        elif kind == 3:
            for i in range(stride): line[i] = (line[i] + ((line[i - 4] if i >= 4 else 0) + previous[i]) // 2) & 255
        elif kind == 4:
            for i in range(stride):
                a, b, c = (line[i - 4] if i >= 4 else 0), previous[i], (previous[i - 4] if i >= 4 else 0)
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        elif kind != 0: raise ValueError('bad PNG filter')
        rows.append(line); previous = line
    return width, height, rows


def write_png(width, height, rows):
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))
    raw = b''.join(b'\x00' + bytes(row) for row in rows)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def shrink(width, height, rows, size):
    """rows box-averaged to size x size, colour weighted by alpha so transparent edges do not darken."""
    spans = lambda n: [(i * n // size, max((i + 1) * n // size, i * n // size + 1)) for i in range(size)]
    xs, out = spans(width), []
    for y0, y1 in spans(height):
        line = bytearray(size * 4)
        for x, (x0, x1) in enumerate(xs):
            r = g = b = a = 0
            for row in rows[y0:y1]:
                for i in range(x0 * 4, x1 * 4, 4):
                    alpha = row[i + 3]; a += alpha
                    r += row[i] * alpha; g += row[i + 1] * alpha; b += row[i + 2] * alpha
            count = (y1 - y0) * (x1 - x0)
            line[x * 4:x * 4 + 4] = (bytes((r // a, g // a, b // a, (a + count // 2) // count)) if a else bytes(4))
        out.append(line)
    return out


def icon(png):
    """{size: PNG bytes} for ICON_SIZES from a square RGBA PNG at least 256 pixels wide."""
    width, height, rows = read_png(png)
    if width != height or width < ICON_SIZES[0]: raise ValueError('icon source must be square and at least 256 pixels')
    big = shrink(width, height, rows, ICON_SIZES[0])
    return {size: write_png(size, size, big if size == ICON_SIZES[0] else shrink(ICON_SIZES[0], ICON_SIZES[0], big, size))
            for size in ICON_SIZES}


def ico(images):
    """The .ico file of {size: PNG bytes}."""
    entries, body, offset = b'', b'', 6 + 16 * len(images)
    for size, png in images.items():
        entries += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(png), offset + len(body))
        body += png
    return struct.pack('<HHH', 0, 1, len(images)) + entries + body


def group_icon(images):
    """RT_GROUP_ICON of {size: PNG bytes}, whose RT_ICON ids are 1, 2, ... in that order."""
    entries = b''.join(struct.pack('<BBBBHHIH', size % 256, size % 256, 0, 0, 1, 32, len(png), number)
                       for number, (size, png) in enumerate(images.items(), 1))
    return struct.pack('<HHH', 0, 1, len(images)) + entries


def _block(key, value=b'', children=(), text=False):
    """One VS_VERSIONINFO node: wLength, wValueLength, wType, the key, padding, the value, padding, the children."""
    head = 6 + len(key.encode('utf-16-le')) + 2
    out = bytearray(head + (-head % 4))
    out[6:head] = key.encode('utf-16-le') + b'\0\0'
    out += value
    for child in children: out += bytes(-len(out) % 4) + child
    struct.pack_into('<HHH', out, 0, len(out), len(value) // 2 if text else len(value), 1 if text else 0)
    return bytes(out)


def _string(key, value):
    return _block(key, value.encode('utf-16-le') + b'\0\0', text=True)


def version_numbers(version):
    """The four 16-bit parts of a dotted version, missing ones 0."""
    parts = [int(part) for part in version.split('.')]
    if not 1 <= len(parts) <= 4 or any(not 0 <= part <= 0xFFFF for part in parts):
        raise ValueError('version parts must be at most four numbers of 0..65535: ' + version)
    return (parts + [0, 0, 0])[:4]


def version_info(product_name, app_version, build_version, executable):
    """RT_VERSION: product and file version app_version, the build version as a string of its own."""
    a, b, c, d = version_numbers(app_version)
    fixed = struct.pack('<13I', 0xFEEF04BD, 0x00010000, a << 16 | b, c << 16 | d, a << 16 | b, c << 16 | d,
                        0x3F, 0, 0x00040004, 1, 0, 0, 0)
    strings = [('CompanyName', product_name), ('FileDescription', product_name), ('FileVersion', app_version),
               ('InternalName', product_name), ('OriginalFilename', executable), ('ProductName', product_name),
               ('ProductVersion', app_version), ('BuildVersion', build_version)]
    table = _block(f'{VERSION_LANG:04x}{VERSION_CODEPAGE:04x}', children=[_string(k, v) for k, v in strings], text=True)
    var = _block('VarFileInfo', children=[_block('Translation', struct.pack('<HH', VERSION_LANG, VERSION_CODEPAGE))], text=True)
    return _block('VS_VERSION_INFO', fixed, [_block('StringFileInfo', children=[table], text=True), var])


def _kernel32():
    from ctypes import wintypes
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.LoadLibraryExW.argtypes = [wintypes.LPCWSTR, wintypes.HANDLE, wintypes.DWORD]; k.LoadLibraryExW.restype = wintypes.HMODULE
    k.FreeLibrary.argtypes = [wintypes.HMODULE]
    k.BeginUpdateResourceW.argtypes = [wintypes.LPCWSTR, wintypes.BOOL]; k.BeginUpdateResourceW.restype = wintypes.HANDLE
    k.UpdateResourceW.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, wintypes.WORD, ctypes.c_void_p, wintypes.DWORD]
    k.EndUpdateResourceW.argtypes = [wintypes.HANDLE, wintypes.BOOL]
    return k


def resources(path):
    """{type: [(name, language), ...]} of RT_ICON, RT_GROUP_ICON and RT_VERSION in the exe; names are ints or strings."""
    from ctypes import wintypes
    k = _kernel32()
    names = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)
    langs = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p, wintypes.WORD, ctypes.c_void_p)
    k.EnumResourceNamesW.argtypes = [wintypes.HMODULE, ctypes.c_void_p, names, ctypes.c_void_p]
    k.EnumResourceLanguagesW.argtypes = [wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p, langs, ctypes.c_void_p]
    module = k.LoadLibraryExW(str(path), None, LOAD_LIBRARY_AS_DATAFILE)
    if not module: raise OSError(ctypes.get_last_error(), 'LoadLibraryExW ' + str(path))
    found = {}
    try:
        for kind in (RT_ICON, RT_GROUP_ICON, RT_VERSION):
            listed = []
            def on_name(_module, _kind, name, _param):
                key = name if name < 0x10000 else ctypes.wstring_at(name)
                def on_lang(_m, _k, _n, lang, _p):
                    listed.append((key, lang)); return True
                k.EnumResourceLanguagesW(module, kind, name, langs(on_lang), None)
                return True
            k.EnumResourceNamesW(module, kind, names(on_name), None)
            found[kind] = listed
    finally:
        k.FreeLibrary(module)
    return found


def read_version(path):
    """{key: value} of the exe's StringFileInfo table VERSION_LANG/VERSION_CODEPAGE."""
    from ctypes import wintypes
    v = ctypes.WinDLL('version', use_last_error=True)
    v.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p]
    v.GetFileVersionInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    v.VerQueryValueW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT)]
    size = v.GetFileVersionInfoSizeW(str(path), None)
    if not size: return {}
    data = ctypes.create_string_buffer(size)
    if not v.GetFileVersionInfoW(str(path), 0, size, data): raise OSError(ctypes.get_last_error(), 'GetFileVersionInfoW')
    out = {}
    for key in ('ProductName', 'FileDescription', 'FileVersion', 'ProductVersion', 'OriginalFilename', 'BuildVersion'):
        pointer, length = ctypes.c_void_p(), wintypes.UINT()
        if v.VerQueryValueW(data, f'\\StringFileInfo\\{VERSION_LANG:04x}{VERSION_CODEPAGE:04x}\\{key}', ctypes.byref(pointer), ctypes.byref(length)):
            out[key] = ctypes.wstring_at(pointer.value, max(length.value - 1, 0))
    return out


def brand(path, *, icon_png, product_name, app_version, build_version, executable):
    """Replace the exe's icons (icon_png None: keep them) and version resource; return what reads back."""
    k = _kernel32()
    old = resources(path)
    groups = old[RT_GROUP_ICON]
    images = icon(icon_png) if icon_png is not None else None
    handle = k.BeginUpdateResourceW(str(path), False)
    if not handle: raise OSError(ctypes.get_last_error(), 'BeginUpdateResourceW ' + str(path))
    keep = []
    def update(kind, name, lang, data):
        buffer = ctypes.create_string_buffer(data, len(data)) if data is not None else None
        keep.append(buffer)
        name_arg = name if isinstance(name, int) else ctypes.c_wchar_p(name)
        if isinstance(name_arg, ctypes.c_wchar_p): keep.append(name_arg)
        if not k.UpdateResourceW(handle, kind, name_arg, lang, buffer, len(data) if data is not None else 0):
            raise OSError(ctypes.get_last_error(), f'UpdateResourceW type={kind} name={name}')
    try:
        if images is not None:
            for kind in (RT_ICON, RT_GROUP_ICON):
                for name, lang in old[kind]: update(kind, name, lang, None)
            group_name, group_lang = groups[0] if groups else (1, VERSION_LANG)
            for number, png in enumerate(images.values(), 1): update(RT_ICON, number, group_lang, png)
            update(RT_GROUP_ICON, group_name, group_lang, group_icon(images))
        for name, lang in old[RT_VERSION]: update(RT_VERSION, name, lang, None)
        update(RT_VERSION, 1, VERSION_LANG, version_info(product_name, app_version, build_version, executable))
    except BaseException:
        k.EndUpdateResourceW(handle, True)
        raise
    if not k.EndUpdateResourceW(handle, False): raise OSError(ctypes.get_last_error(), 'EndUpdateResourceW ' + str(path))
    now = resources(path)
    return dict(version=read_version(path), icons=len(now[RT_ICON]), icon_groups=[str(name) for name, _ in now[RT_GROUP_ICON]],
                icon_sizes=list(images) if images is not None else None)


if __name__ == '__main__':
    if len(sys.argv) != 4 or sys.argv[1] != 'ico': sys.exit(__doc__)
    with open(sys.argv[2], 'rb') as source: images = icon(source.read())
    with open(sys.argv[3], 'wb') as out: out.write(ico(images))
