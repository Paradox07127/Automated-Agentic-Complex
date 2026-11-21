"""Plain text from Word, Excel and PowerPoint files already read into memory.

Raises ValueError(workspace error code); the workspace wraps it, so this module does not import it back.
"""
from __future__ import annotations

import io
import posixpath
import xml.etree.ElementTree as ET
import zipfile
import zlib

MAX_EXTRACTED = 8 * 1024 * 1024
MAX_MEMBERS = 2000
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
S = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
P = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
REL = '{http://schemas.openxmlformats.org/package/2006/relationships}'


class _TooLarge(Exception):
    pass


class _NoDoctype(ET.TreeBuilder):
    # Office parts never declare a DTD; refusing it also refuses entity expansion.
    def doctype(self, name, pubid, system):
        raise ValueError('doctype')


class _Package:
    """Reads members against one budget of declared uncompressed sizes."""

    def __init__(self, archive):
        self.archive, self.left = archive, MAX_EXTRACTED

    def has(self, name):
        return name in self.archive.NameToInfo

    def xml(self, name):
        info = self.archive.getinfo(name)
        self.left -= info.file_size
        if self.left < 0:
            raise _TooLarge()
        # bzip2 and lzma members decompress without an output bound in zipfile.
        if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise ValueError('compression')
        with self.archive.open(info) as stream:
            data = stream.read(info.file_size)
        parser = ET.XMLParser(target=_NoDoctype())
        parser.feed(data)
        return parser.close()

    def rels(self, name):
        """Relationship id -> member name for one part."""
        folder, base = posixpath.split(name)
        root = self.xml(posixpath.join(folder, '_rels', base + '.rels'))
        return {r.get('Id'): posixpath.normpath(posixpath.join(folder, r.get('Target', ''))).lstrip('/')
                for r in root.iter(REL + 'Relationship')}


def _paragraph(element):
    return ''.join(t.text or '' for t in element.iter(W + 't'))


def _blocks(element):
    lines = []
    for child in element:
        if child.tag == W + 'p':
            lines.append(_paragraph(child))
        elif child.tag == W + 'tbl':
            lines.extend('\t'.join(' '.join(_paragraph(p) for p in cell.iter(W + 'p')) for cell in row.findall(W + 'tc'))
                         for row in child.findall(W + 'tr'))
        else:
            lines.extend(_blocks(child))
    return lines


def _docx(package):
    return '\n'.join(_blocks(package.xml('word/document.xml')))


def _string(item):
    # Direct text or rich-text runs; phonetic hints (rPh) are left out.
    return ''.join(t.text or '' for t in [*item.findall(S + 't'), *item.findall(S + 'r/' + S + 't')])


def _cell(cell, shared):
    if cell.get('t') == 'inlineStr':
        item = cell.find(S + 'is')
        return '' if item is None else _string(item)
    value = cell.findtext(S + 'v') or ''
    return shared[int(value)] if cell.get('t') == 's' and value else value


def _column(reference):
    """1-based column of a cell reference such as 'AB12'; 0 when it has none."""
    column = 0
    for letter in reference or '':
        if not 'A' <= letter <= 'Z':
            break
        column = column * 26 + ord(letter) - 64
    return column


def _xlsx(package):
    shared = ([_string(si) for si in package.xml('xl/sharedStrings.xml').iter(S + 'si')]
              if package.has('xl/sharedStrings.xml') else [])
    targets = package.rels('xl/workbook.xml'); lines = []
    for sheet in package.xml('xl/workbook.xml').iter(S + 'sheet'):
        lines.append('# ' + sheet.get('name', ''))
        for row in package.xml(targets[sheet.get(R + 'id')]).iter(S + 'row'):
            values = []
            for cell in row.iter(S + 'c'):
                column = _column(cell.get('r')) or len(values) + 1
                # Padding is output the member sizes did not pay for.
                package.left -= column - len(values)
                if package.left < 0:
                    raise _TooLarge()
                values.extend([''] * (column - 1 - len(values)))
                values.append(_cell(cell, shared))
            if any(values):
                lines.append('\t'.join(values))
    return '\n'.join(lines)


def _pptx(package):
    targets = package.rels('ppt/presentation.xml'); lines = []
    for number, slide in enumerate(package.xml('ppt/presentation.xml').iter(P + 'sldId'), 1):
        lines.append(f'# 第 {number} 页')
        for paragraph in package.xml(targets[slide.get(R + 'id')]).iter(A + 'p'):
            text = ''.join(t.text or '' for t in paragraph.iter(A + 't'))
            if text:
                lines.append(text)
    return '\n'.join(lines)


EXTRACTORS = {'.docx': _docx, '.xlsx': _xlsx, '.pptx': _pptx}


def extract(suffix, data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if len(archive.infolist()) > MAX_MEMBERS:
                raise _TooLarge()
            text = EXTRACTORS[suffix](_Package(archive))
    except _TooLarge as error:
        raise ValueError('file_too_large') from error
    except (zipfile.BadZipFile, KeyError, IndexError, ValueError, ET.ParseError, RuntimeError, EOFError, zlib.error) as error:
        raise ValueError('unsupported_file') from error
    if not text.strip():
        raise ValueError('no_text')
    return text
