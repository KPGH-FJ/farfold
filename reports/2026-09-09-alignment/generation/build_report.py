from pathlib import Path
import re
from docx import Document
from docx.shared import Cm, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE as RT

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'Farfold-技术路径与发展规划对齐报告.md'
OUT = ROOT / 'Farfold-技术路径与发展规划对齐报告.docx'
doc = Document()
section = doc.sections[0]
section.page_width, section.page_height = Cm(21), Cm(29.7)
section.top_margin, section.bottom_margin = Cm(1.8), Cm(1.7)
section.left_margin = section.right_margin = Cm(1.9)
section.footer_distance = Cm(0.7)

for name, size in [('Normal', 10.5), ('Title', 23), ('Subtitle', 10),
                   ('Heading 1', 17), ('Heading 2', 12.5), ('List Bullet', 10.5)]:
    style = doc.styles[name]
    style.font.name = 'Arial'
    style.font.size = Pt(size)
    style.font.color.rgb = RGBColor(0, 0, 0)
    style.element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'), 'Heiti SC')
    style.font.italic = False
    for element in style.element.iter():
        for attr in list(element.attrib):
            if 'theme' in attr.lower(): del element.attrib[attr]
    for border in list(style.element.iter(qn('w:pBdr'))): border.getparent().remove(border)
    pf = style.paragraph_format
    pf.space_after = Pt(5)
    pf.line_spacing = 1.12
    pf.widow_control = True
    if name.startswith('Heading'):
        pf.space_before = Pt(10)
        pf.space_after = Pt(7)
        pf.keep_with_next = True
    if name == 'Title':
        pf.space_after = Pt(10)

def font(run, size=None, bold=None):
    run.font.name = 'Arial'
    run._element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'), 'Heiti SC')
    if size: run.font.size = Pt(size)
    if bold is not None: run.bold = bold

def inline(p, text, size=None):
    for part in re.split(r'(\*\*.*?\*\*|\[[^\]]+\]\([^)]+\))', text):
        if not part: continue
        match = re.fullmatch(r'\[([^\]]+)\]\(([^)]+)\)', part)
        if match:
            label, url = match.groups()
            h = OxmlElement('w:hyperlink')
            h.set(qn('r:id'), p.part.relate_to(url, RT.HYPERLINK, is_external=True))
            r = OxmlElement('w:r')
            prop = OxmlElement('w:rPr')
            color = OxmlElement('w:color'); color.set(qn('w:val'), '254F75'); prop.append(color)
            fonts = OxmlElement('w:rFonts'); fonts.set(qn('w:eastAsia'), 'Heiti SC'); prop.append(fonts)
            if size:
                sz = OxmlElement('w:sz'); sz.set(qn('w:val'), str(int(size*2))); prop.append(sz)
            r.append(prop)
            t = OxmlElement('w:t'); t.text = label; r.append(t); h.append(r); p._p.append(h)
        else:
            bold = part.startswith('**') and part.endswith('**')
            font(p.add_run(part[2:-2] if bold else part), size, bold)

def make_table(lines):
    rows = [[c.strip() for c in row.strip().strip('|').split('|')] for row in lines]
    rows = [r for r in rows if not all(re.fullmatch(r':?-+:?', c) for c in r)]
    table = doc.add_table(rows=0, cols=len(rows[0]))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    widths = [3.6, 6.6, 7.0] if len(rows[0]) == 3 else [17.2/len(rows[0])]*len(rows[0])
    for col, width in zip(table.columns, widths): col.width = Cm(width)
    pr = table._tbl.tblPr
    borders = OxmlElement('w:tblBorders')
    for side in ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']:
        e = OxmlElement('w:'+side)
        for key, val in [('val','single'), ('sz','4'), ('color','D9D9D9')]: e.set(qn('w:'+key), val)
        borders.append(e)
    pr.append(borders)
    for index, data in enumerate(rows):
        row = table.add_row()
        trpr = row._tr.get_or_add_trPr()
        trpr.append(OxmlElement('w:cantSplit'))
        if index == 0: trpr.append(OxmlElement('w:tblHeader'))
        for j, value in enumerate(data):
            cell = row.cells[j]; cell.width = Cm(widths[j])
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            tcpr = cell._tc.get_or_add_tcPr()
            margins = OxmlElement('w:tcMar')
            for side in ['top','bottom','left','right']:
                e = OxmlElement('w:'+side); e.set(qn('w:w'), '85'); e.set(qn('w:type'), 'dxa'); margins.append(e)
            tcpr.append(margins)
            shade = OxmlElement('w:shd'); shade.set(qn('w:fill'), 'E7EEF3' if index == 0 else 'FFFFFF'); tcpr.append(shade)
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.space_before = Pt(0)
            p.paragraph_format.line_spacing = 1.12
            inline(p, value, 9.3)
            if index == 0:
                for r in p.runs: r.bold = True
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(0)
    spacer.paragraph_format.space_before = Pt(0)
    spacer.paragraph_format.line_spacing = 0.4
    font(spacer.add_run(''), 3)

lines = SOURCE.read_text().splitlines()
i = 0
in_sources = False
new_page = False
while i < len(lines):
    line = lines[i].strip()
    if not line: i += 1; continue
    if line == '<!-- pagebreak -->':
        new_page = True; i += 1; continue
    if line.startswith('|'):
        block = []
        while i < len(lines) and lines[i].strip().startswith('|'):
            block.append(lines[i]); i += 1
        make_table(block); continue
    if line.startswith('# '):
        p = doc.add_paragraph(style='Title'); inline(p, line[2:])
    elif line.startswith('## '):
        in_sources = line.startswith('## 10 ')
        p = doc.add_paragraph(style='Heading 1'); inline(p, line[3:])
        if new_page: p.paragraph_format.page_break_before = True
        new_page = False
    elif line.startswith('### '):
        p = doc.add_paragraph(style='Heading 2'); inline(p, line[4:])
    elif line.startswith('- '):
        p = doc.add_paragraph(style='List Bullet'); inline(p, line[2:], 9 if in_sources else None)
        if in_sources:
            p.paragraph_format.space_after = Pt(4)
            p.paragraph_format.line_spacing = 1.08
    elif line.startswith('2026 年'):
        p = doc.add_paragraph(style='Subtitle'); inline(p, line)
    else:
        p = doc.add_paragraph(); inline(p, line, 9.5 if in_sources else None)
    i += 1

footer = section.footer.paragraphs[0]
footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
font(footer.add_run('Farfold  ·  '), 8)
field = OxmlElement('w:fldSimple'); field.set(qn('w:instr'), 'PAGE'); footer._p.append(field)
doc.core_properties.title = 'Farfold 技术路径与发展规划对齐报告'
doc.core_properties.subject = '产品研发对齐与商业计划书基础材料'
doc.core_properties.author = 'Farfold'
doc.core_properties.keywords = 'Farfold, 产品, 技术路径, 规划, 商业计划书'
doc.save(OUT)
print(OUT)
