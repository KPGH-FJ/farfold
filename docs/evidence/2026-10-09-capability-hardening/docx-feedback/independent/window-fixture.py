"""CC0 synthetic source-coordinate window fixture, independent of Farfold.

Original samples/oracles and the sealed nine-capture Worker checkpoint stay
unchanged. XML literal positions are independently checked with minidom.
"""
from pathlib import Path
from io import BytesIO
from xml.dom import minidom
import base64
import hashlib
import json
import zipfile
OUT = Path(__file__).resolve().parent
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
long_text = 'LONG SOURCE 段落 ' + ('甲' * 40030) + ' END LONG SOURCE'
paragraph = '<w:p><w:r><w:t>' + long_text + '</w:t></w:r></w:p>'
rows = ''.join('<w:tr>' + ''.join(
    '<w:tc><w:p><w:r><w:t>ROW%d COL%d</w:t></w:r></w:p></w:tc>' % (r + 1, c + 1)
    for c in range(13)) + '</w:tr>' for r in range(21))
grid = '<w:tblGrid>' + '<w:gridCol w:w="1000"/>' * 13 + '</w:tblGrid>'
document = '<w:document xmlns:w="' + W + '"><w:body>' + paragraph + '<w:tbl>' + grid + rows + '</w:tbl></w:body></w:document>'
parts = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="' + R + '/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': document,
}
buffer = BytesIO()
with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, content in parts.items():
        info = zipfile.ZipInfo(name, (2026, 10, 10, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, content.encode())
raw = buffer.getvalue()
name = 'window-boundaries.docx'
sha = hashlib.sha256(raw).hexdigest()
source = OUT / name
if source.exists():
    assert source.read_bytes() == raw
else:
    source.write_bytes(raw)
dom = minidom.parseString(document)
def element(path):
    node = dom.documentElement
    for i in path:
        node = [c for c in node.childNodes if c.nodeType == c.ELEMENT_NODE][i]
    return node
assert element([0, 0]).localName == 'p'
assert element([0, 1]).localName == 'tbl'
assert element([0, 1, 21, 12, 0]).getElementsByTagNameNS(W, 't')[0].firstChild.data == 'ROW21 COL13'
dom.unlink()
oracle = {'license': 'CC0-1.0 synthetic text/XML and generator', 'file': name, 'sha256': sha,
          'bytes': len(raw), 'longParagraph': {'part': 'word/document.xml', 'elementPath': [0, 0], 'utf16Length': len(long_text)},
          'table': {'part': 'word/document.xml', 'elementPath': [0, 1], 'rows': 21, 'columns': 13},
          'lastCellParagraph': {'part': 'word/document.xml', 'elementPath': [0, 1, 21, 12, 0], 'text': 'ROW21 COL13'},
          'method': 'Literal original XML path checked with minidom; no production parser import; structure coordinates, not Word pagination.'}
capture = {'file': {'root': '/controlled', 'path': '/controlled/' + name, 'resolvedPath': '/controlled/' + name,
                    'name': name, 'version': 'controlled:' + sha, 'sha256': sha, 'size': len(raw)},
           'parts': [{'name': key, 'data': base64.b64encode(value.encode()).decode()} for key, value in parts.items()],
           'entries': list(parts), 'inflatedBytes': sum(len(value.encode()) for value in parts.values())}
all_captures = json.loads((OUT / 'captures.json').read_text())
all_captures[name] = capture
for output, value in [('window-oracle.json', oracle), ('app-captures.json', all_captures)]:
    dest = OUT / output
    if dest.exists():
        assert json.loads(dest.read_text()) == value
    else:
        dest.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'file': name, 'sha256': sha, 'bytes': len(raw), 'literalCoordinates': 3, 'captureSamples': len(all_captures)}))
