"""Independent OOXML/ZIP writer and oracle, not the Farfold text converter."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape
import hashlib
import json
import re

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
BASE = REPO / "docs/evidence/2026-10-09-capability-hardening/docx-fixtures"
DEST = HERE / "fixtures"
DEST.mkdir(exist_ok=True)

def base(name):
    with ZipFile(BASE / (name + ".docx")) as source:
        return {name: source.read(name) for name in source.namelist()}

def paragraph(text):
    return '<w:p><w:r><w:t xml:space="preserve">' + escape(text) + '</w:t></w:r></w:p>'

def body(parts, xml):
    parts["word/document.xml"] = re.sub(
        r"<w:body>[\s\S]*</w:body>", "<w:body>" + xml + "</w:body>",
        parts["word/document.xml"].decode(),
    ).encode()

files = []
def save(name, parts, oracle):
    path = DEST / (name + ".docx")
    if path.exists():
        raise RuntimeError("refuse to replace fixture: " + str(path))
    with path.open("xb") as stream:
        with ZipFile(stream, "w", compression=ZIP_DEFLATED) as archive:
            for entry, data in parts.items():
                archive.writestr(entry, data)
    files.append({"name": name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), **oracle})

parts = base("07-header-footer-footnote")
markers = ["BEGIN_8c52", "LONG_END_721a", "LAST_CELL_8f94", "BODY_END_99e1"]
long = "LONG_BEGIN_29a0 " + "长段落的每一部分都应保留。" * 1400 + " " + markers[1]
cell_values = []
rows = []
for row in range(70):
    cells = []
    for col in range(4):
        if row == 0 and col == 1:
            continue
        props = ('<w:gridSpan w:val="2"/>' if row == 0 and col == 0 else "")
        props += ('<w:vMerge w:val="restart"/>' if row == 1 and col == 0 else '<w:vMerge/>' if row == 2 and col == 0 else "")
        value = f'R{row+1}C{col+1} | "quoted"\n第二行'
        if row == 69 and col == 3:
            value += " " + markers[2]
        if row == 2 and col == 0:
            content = "<w:p/>"
        else:
            cell_values.append(value)
            content = paragraph(value)
        if row == 42 and col == 2:
            content += '<w:tbl><w:tblGrid><w:gridCol w:w="1000"/></w:tblGrid><w:tr><w:tc>' + paragraph("NESTED_54b6 | 0 false") + '</w:tc></w:tr></w:tbl>'
        cells.append("<w:tc><w:tcPr>" + props + "</w:tcPr>" + content + "</w:tc>")
    rows.append("<w:tr>" + "".join(cells) + "</w:tr>")
table = '<w:tbl><w:tblGrid>' + '<w:gridCol w:w="1500"/>' * 4 + '</w:tblGrid>' + "".join(rows) + '</w:tbl>'
body(parts, paragraph(markers[0]) + paragraph(long) + table + paragraph('[1] 是作者原样文字；0 false 😀') + '<w:p><w:r><w:t>正文脚注位置</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>' + '<w:p><w:fldSimple w:instr="DATE"><w:r><w:t>SAVED_FIELD_753f</w:t></w:r></w:fldSimple></w:p>' + paragraph(markers[3]) + '<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/></w:sectPr>')
save("complete", parts, {"markers": markers, "longParagraph": long, "cellValues": cell_values, "nested": "NESTED_54b6 | 0 false", "rows": 70, "columns": 4, "merges": [[1, 1, 1, 2], [2, 1, 2, 1]], "storyText": ["FOOTNOTE public fixture"], "savedField": "SAVED_FIELD_753f"})

parts = base("05-inline-png-jpeg")
original = parts["word/document.xml"].decode()
drawing = re.search(r"<w:p><w:r><w:drawing>[\s\S]*?</w:drawing></w:r></w:p>", original).group()
parts["word/footnotes.xml"] = b'<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r></w:p></w:footnote></w:footnotes>'
parts["word/_rels/document.xml.rels"] = parts["word/_rels/document.xml.rels"].replace(b'</Relationships>', b'<Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>')
parts["[Content_Types].xml"] = parts["[Content_Types].xml"].replace(b'</Types>', b'<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>')
marker_only = drawing + '<w:p><w:r><w:footnoteReference w:id="1"/></w:r></w:p>'
body(parts, marker_only)
save("image-empty-note", parts, {"expectedNoText": True, "images": 1, "noteId": "1"})
body(parts, marker_only + paragraph("[1]"))
save("literal-marker", parts, {"literal": "[1]", "expectedActualTextChars": 3})

parts = base("01-text-values")
body(parts, paragraph("VISIBLE_428a") + '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>HIDDEN_d4a5_MUST_NOT_APPEAR</w:t></w:r></w:p>')
save("partial-hidden", parts, {"visible": "VISIBLE_428a", "omitted": "HIDDEN_d4a5_MUST_NOT_APPEAR", "partial": True})
body(parts, '<w:p><w:r><w:object/></w:r></w:p>')
save("active-object", parts, {"error": "unsupported"})

oracle = DEST / "oracle.json"
with oracle.open("x", encoding="utf-8") as stream:
    json.dump({"writer": "Python standard-library ZipFile and literal OOXML; no product parser/converter", "files": files}, stream, ensure_ascii=False, indent=2)
    stream.write("\n")
print("wrote", len(files), "independent ZIP fixtures and oracle")
