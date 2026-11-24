import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services import extract as extract_module
from character_agent.services.extract import extract

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
REL = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'


def package(members):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, text in members.items(): archive.writestr(name, text)
    return buffer.getvalue()


def rels(targets):
    return f'<Relationships {REL}>' + ''.join(
        f'<Relationship Id="{key}" Type="t" Target="{value}"/>' for key, value in targets.items()) + '</Relationships>'


def paragraph(text):
    return f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>'


def docx(*paragraphs, table=()):
    rows = ''.join('<w:tr>' + ''.join(f'<w:tc>{paragraph(cell)}</w:tc>' for cell in row) + '</w:tr>' for row in table)
    body = ''.join(paragraph(p) for p in paragraphs) + (f'<w:tbl>{rows}</w:tbl>' if table else '')
    return package({'word/document.xml': f'<w:document {W}><w:body>{body}<w:sectPr/></w:body></w:document>'})


def xlsx():
    shared = f'<sst {S}><si><t>名称</t></si><si><r><t>苹</t></r><r><t>果</t></r></si></sst>'
    sheet1 = (f'<worksheet {S}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>数量</t></is></c></row>'
              '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>3.5</v></c><c r="C2"><f>B2*2</f><v>7</v></c></row></sheetData></worksheet>')
    sheet2 = f'<worksheet {S}><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>'
    workbook = f'<workbook {S} {R}><sheets><sheet name="库存" sheetId="1" r:id="rId1"/><sheet name="备注" sheetId="2" r:id="rId2"/></sheets></workbook>'
    return package({'xl/workbook.xml': workbook, 'xl/sharedStrings.xml': shared,
                    'xl/_rels/workbook.xml.rels': rels({'rId1': 'worksheets/sheet1.xml', 'rId2': '/xl/worksheets/sheet2.xml'}),
                    'xl/worksheets/sheet1.xml': sheet1, 'xl/worksheets/sheet2.xml': sheet2})


def slide(*texts):
    shapes = ''.join(f'<p:sp><p:txBody><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:txBody></p:sp>' for t in texts)
    return f'<p:sld {P} {A}><p:cSld><p:spTree>{shapes}</p:spTree></p:cSld></p:sld>'


def pptx():
    presentation = f'<p:presentation {P} {R}><p:sldIdLst><p:sldId id="256" r:id="rId7"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>'
    return package({'ppt/presentation.xml': presentation,
                    'ppt/_rels/presentation.xml.rels': rels({'rId3': 'slides/slide1.xml', 'rId7': 'slides/slide2.xml'}),
                    'ppt/slides/slide1.xml': slide('第二页标题'), 'ppt/slides/slide2.xml': slide('开场', '议程')})


class ExtractTests(unittest.TestCase):
    def assertCode(self, code, suffix, data):
        with self.assertRaises(ValueError) as error: extract(suffix, data)
        self.assertEqual(str(error.exception), code)

    def test_docx_paragraphs_and_table_rows(self):
        text = extract('.docx', docx('第一段文字', '第二段文字', table=[['甲', '乙'], ['丙', '丁']]))
        self.assertEqual(text.splitlines(), ['第一段文字', '第二段文字', '甲\t乙', '丙\t丁'])

    def test_xlsx_sheets_shared_inline_numbers_and_cached_formula(self):
        self.assertEqual(extract('.xlsx', xlsx()).splitlines(),
                         ['# 库存', '名称\t数量', '苹果\t3.5\t7', '# 备注', '42'])

    def test_xlsx_keeps_a_cell_in_its_column_when_earlier_cells_are_absent(self):
        sheet = (f'<worksheet {S}><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row>'
                 '<row r="2"><c r="B2"><v>2</v></c></row></sheetData></worksheet>')
        workbook = f'<workbook {S} {R}><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>'
        data = package({'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': rels({'rId1': 'worksheets/sheet1.xml'}),
                        'xl/worksheets/sheet1.xml': sheet})
        self.assertEqual(extract('.xlsx', data).split('\n'), ['# s', '1\t\t3', '\t2'])
        wide = sheet.replace('r="C1"', 'r="XFD1"')
        with patch.object(extract_module, 'MAX_EXTRACTED', 4096):
            self.assertCode('file_too_large', '.xlsx', package({
                'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': rels({'rId1': 'worksheets/sheet1.xml'}),
                'xl/worksheets/sheet1.xml': wide}))

    def sheet(self, cells, shared=None):
        sheet = f'<worksheet {S}><sheetData><row r="1">{cells}</row></sheetData></worksheet>'
        workbook = f'<workbook {S} {R}><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>'
        members = {'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': rels({'rId1': 'worksheets/sheet1.xml'}),
                   'xl/worksheets/sheet1.xml': sheet}
        if shared is not None:
            members['xl/sharedStrings.xml'] = f'<sst {S}>' + ''.join(f'<si><t>{s}</t></si>' for s in shared) + '</sst>'
        return package(members)

    def test_xlsx_charges_each_shared_string_reference_against_the_budget(self):
        data = self.sheet(''.join(f'<c t="s"><v>0</v></c>' for _ in range(20)), shared=['x' * 1000])
        with patch.object(extract_module, 'MAX_EXTRACTED', 8192):
            self.assertCode('file_too_large', '.xlsx', data)

    def test_xlsx_refuses_a_cell_before_the_rows_last_column(self):
        self.assertCode('unsupported_file', '.xlsx', self.sheet('<c r="ZZZ1"><v>1</v></c>' + '<c r="A1"><v>2</v></c>' * 500))
        self.assertCode('unsupported_file', '.xlsx', self.sheet('<c r="B1"><v>1</v></c><c r="B1"><v>2</v></c>'))

    def test_xlsx_refuses_a_shared_string_index_outside_the_table(self):
        for index in ('-1', '1'):
            with self.subTest(index=index):
                self.assertCode('unsupported_file', '.xlsx', self.sheet(f'<c r="A1" t="s"><v>{index}</v></c>', shared=['a']))

    def test_pptx_slides_in_presentation_order(self):
        self.assertEqual(extract('.pptx', pptx()).splitlines(),
                         ['# 第 1 页', '开场', '议程', '# 第 2 页', '第二页标题'])

    def test_bad_or_empty_or_oversized_packages_are_refused(self):
        self.assertCode('unsupported_file', '.docx', b'plain text, not a zip')
        self.assertCode('unsupported_file', '.docx', package({'word/other.xml': '<a/>'}))
        self.assertCode('unsupported_file', '.docx', package({'word/document.xml': '<w:document'}))
        self.assertCode('no_text', '.docx', docx())
        with patch.object(extract_module, 'MAX_EXTRACTED', 64):
            self.assertCode('file_too_large', '.docx', docx('x' * 100))
        self.assertCode('file_too_large', '.docx', package({f'm{n}': '' for n in range(2001)}))

    def test_entity_declarations_and_other_compression_are_refused(self):
        doctype = f'<!DOCTYPE w:document [<!ENTITY x "text">]><w:document {W}><w:body>{paragraph("&x;")}</w:body></w:document>'
        self.assertCode('unsupported_file', '.docx', package({'word/document.xml': doctype}))
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_BZIP2) as archive:
            archive.writestr('word/document.xml', f'<w:document {W}><w:body>{paragraph("bz")}</w:body></w:document>')
        self.assertCode('unsupported_file', '.docx', buffer.getvalue())


if __name__ == '__main__':
    unittest.main()
