"""Independent DOCX structure fixtures/oracle; no Farfold parser imports.

New synthetic text/XML is CC0-1.0. Original writer ZIPs and their oracle are
read-only. These structures are evidence inputs, not Word layout truth or a
claim that every paragraph is displayed or eligible for feedback.
"""
from pathlib import Path
from io import BytesIO
from xml.dom import minidom
import xml.etree.ElementTree as ET
import hashlib
import json
import zipfile

OUT = Path(__file__).resolve().parent
BASE = OUT.parent.parent
REPO = BASE.parents[2]
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
CONTENT_TYPES = ('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                 '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                 '<Default Extension="xml" ContentType="application/xml"/>'
                 '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                 '</Types>')
RELS = ('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="main" Type="' + R + '/officeDocument" Target="word/document.xml"/>'
        '</Relationships>')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def write_once(path, raw):
    if path.exists():
        assert path.read_bytes() == raw, str(path)
    else:
        path.write_bytes(raw)


def element(root, path):
    for index in path:
        root = [n for n in root.childNodes if n.nodeType == n.ELEMENT_NODE][index]
    return root


def dom_text(node):
    return ''.join(c.data for t in node.getElementsByTagNameNS(W, 't')
                   for c in t.childNodes if c.nodeType in [c.TEXT_NODE, c.CDATA_SECTION_NODE])


def ref(path):
    raw = path.read_bytes()
    return {'path': str(path.relative_to(REPO)), 'sha256': sha(raw), 'bytes': len(raw)}


def original_checks():
    path = OUT.parent / 'fixtures/oracle.json'
    original = json.loads(path.read_text())
    checked = 0
    for sample in original['fixtures']:
        source = REPO / sample['file']
        assert sha(source.read_bytes()) == sample['sha256']
        with zipfile.ZipFile(source) as archive:
            assert archive.testzip() is None
            roots = {}
            for part in sample['parts']:
                raw = archive.read(part['part'])
                assert sha(raw) == part['sha256']
                roots[part['part']] = minidom.parseString(raw)
            for target in sample['targets']:
                node = element(roots[target['part']].documentElement, target['elementPath'])
                assert node.namespaceURI == W
                assert node.localName == ('p' if target['blockKind'] == 'paragraph' else 'tbl')
                assert dom_text(node) == target['text']
                assert sha(target['text'].encode()) == target['textSha256']
                checked += 1
            for dom in roots.values():
                dom.unlink()
    assert checked == 96
    return {'originalOracle': ref(path), 'files': len(original['fixtures']),
            'structuralRoundtrips': checked, 'renderedOrEligibleCount': None,
            'method': 'Independently open CRC-checked original ZIP parts; minidom element-only literal path resolution. No execution/import of original oracle.py or Farfold parser.',
            'originalFiles': [ref(REPO / f['file']) for f in original['fixtures']]}


SAMPLES = [
    {
        'name': 'supported-choice-markers.docx',
        'body': '<!--not an element--><w:bookmarkStart w:id="1" w:name="sample"/>'
                '<mc:AlternateContent><mc:Choice Requires="w">'
                '<w:p><w:pPr><w:keepNext/></w:pPr><w:r><w:t>CHOICE VISIBLE 同文</w:t></w:r></w:p>'
                '</mc:Choice><mc:Fallback><w:p><w:r><w:t>FALLBACK MUST NOT DISPLAY</w:t></w:r></w:p>'
                '</mc:Fallback></mc:AlternateContent><w:proofErr w:type="spellStart"/>'
                '<w:p><w:r><w:t>AFTER MARKER</w:t></w:r></w:p><w:sectPr/>',
        'literalTargets': [
            {'path': [0, 1, 0, 0], 'text': 'CHOICE VISIBLE 同文', 'disposition': 'selected supported Choice paragraph'},
            {'path': [0, 1, 1, 0], 'text': 'FALLBACK MUST NOT DISPLAY', 'disposition': 'unselected branch; never a candidate'},
            {'path': [0, 3], 'text': 'AFTER MARKER', 'disposition': 'visible paragraph; preceding ignored marker still counts'},
        ],
        'expectation': 'Supported Requires=w selects Choice. Comments do not count; bookmark/proof elements and MC wrappers do. The paragraph pPr is an original child and is not removed from the XML tree.'
    },
    {
        'name': 'nested-choice-fallback.docx',
        'body': '<mc:AlternateContent><mc:Choice Requires="w">'
                '<mc:AlternateContent><mc:Choice Requires="fx"><w:p><w:r><w:t>INNER UNKNOWN MUST NOT DISPLAY</w:t></w:r></w:p></mc:Choice>'
                '<mc:Fallback><w:p><w:r><w:t>NESTED FALLBACK</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>'
                '</mc:Choice><mc:Fallback><w:p><w:r><w:t>OUTER UNSELECTED</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>'
                '<w:p><w:r><w:t>AFTER NESTED</w:t></w:r></w:p><w:sectPr/>',
        'literalTargets': [
            {'path': [0, 0, 0, 0, 0, 0], 'text': 'INNER UNKNOWN MUST NOT DISPLAY', 'disposition': 'inner unselected Choice'},
            {'path': [0, 0, 0, 0, 1, 0], 'text': 'NESTED FALLBACK', 'disposition': 'structural semantic fallback; current parser profile may reject whole package'},
            {'path': [0, 0, 1, 0], 'text': 'OUTER UNSELECTED', 'disposition': 'outer unselected Fallback'},
            {'path': [0, 1], 'text': 'AFTER NESTED', 'disposition': 'structural paragraph after compatibility wrapper'},
        ],
        'expectation': 'Do not silently expand existing format support for location work. If nested MC is unsupported, require explicit whole-preview rejection and no accepted target. If separately authorized later, exact selected original path above is the oracle; never flatten ancestor paths.'
    },
    {
        'name': 'hidden-notice-boundaries.docx',
        'body': '<w:bookmarkStart w:id="2" w:name="hidden"/>'
                '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>HIDDEN ONLY MUST NOT LEAK</w:t></w:r></w:p>'
                '<w:p><w:pPr><w:keepNext/></w:pPr></w:p>'
                '<w:p><w:r><w:t>VISIBLE BEFORE </w:t></w:r><w:r><w:rPr><w:webHidden/></w:rPr><w:t>MIXED HIDDEN MUST NOT LEAK</w:t></w:r><w:r><w:t> VISIBLE AFTER</w:t></w:r></w:p>'
                '<w:sdt><w:sdtPr/><w:sdtContent><w:p><w:r><w:t>OMITTED CONTENT MUST NOT LEAK</w:t></w:r></w:p></w:sdtContent></w:sdt>'
                '<w:p><w:fldSimple w:instr="PAGE"/></w:p>'
                '<w:p><w:r><w:t>VISIBLE END</w:t></w:r></w:p><w:sectPr/>',
        'literalTargets': [
            {'path': [0, 1], 'text': 'HIDDEN ONLY MUST NOT LEAK', 'disposition': 'hiddenContent notice only; original raw text must not render'},
            {'path': [0, 2], 'text': '', 'disposition': 'real empty source paragraph; eligibility must be explicitly defined, not inferred from text length'},
            {'path': [0, 3], 'text': 'VISIBLE BEFORE MIXED HIDDEN MUST NOT LEAK VISIBLE AFTER', 'disposition': 'visible content and hidden notice; whole original paragraph path retained without hidden text'},
            {'path': [0, 4, 1, 0], 'text': 'OMITTED CONTENT MUST NOT LEAK', 'disposition': 'structural descendant only; standalone sdt notice cannot expose this as visible paragraph target'},
            {'path': [0, 5], 'text': '', 'disposition': 'missingFieldResult notice only; eligibility must be explicitly defined'},
            {'path': [0, 6], 'text': 'VISIBLE END', 'disposition': 'visible paragraph after omitted block retains original index'},
        ],
        'expectation': 'Hidden raw text and omitted sdt body never render; notices remain explicit/partial. Standalone notice never has a paragraph/table source. Mixed paragraph may target the whole source, with omission disclosed. Empty and only-notice eligibility is separately checked against agreed factory policy.'
    }
]


def supplement():
    results = []
    for sample in SAMPLES:
        xml = ('<?xml version="1.0" encoding="UTF-8"?>'
               '<w:document xmlns:w="' + W + '" xmlns:mc="' + MC + '" xmlns:r="' + R + '" xmlns:fx="urn:independent:unknown">'
               '<w:body>' + sample['body'] + '</w:body></w:document>').encode()
        parts = {'[Content_Types].xml': CONTENT_TYPES.encode(), '_rels/.rels': RELS.encode(), 'word/document.xml': xml}
        output = BytesIO()
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as z:
            for name, raw in parts.items():
                info = zipfile.ZipInfo(name, (2026, 10, 10, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                z.writestr(info, raw)
        path = OUT / sample['name']
        write_once(path, output.getvalue())
        with zipfile.ZipFile(path) as z:
            assert z.testzip() is None
            assert all(z.read(name) == raw for name, raw in parts.items())
        dom = minidom.parseString(xml)
        tree = ET.fromstring(xml)
        for target in sample['literalTargets']:
            node = element(dom.documentElement, target['path'])
            assert node.namespaceURI == W and node.localName == 'p'
            assert dom_text(node) == target['text']
            et = tree
            for index in target['path']:
                et = list(et)[index]
            assert et.tag == '{' + W + '}p'
            assert ''.join(n.text or '' for n in et.iter('{' + W + '}t')) == target['text']
        dom.unlink()
        results.append({'file': ref(path), 'kind': 'new small authored XML fixture, not independent ordinary writer output',
                        'mainPart': 'word/document.xml', 'xmlSha256': sha(xml), 'expectation': sample['expectation'],
                        'literalTargets': [{**t, 'part': 'word/document.xml', 'blockKind': 'paragraph'} for t in sample['literalTargets']]})
    return results


if __name__ == '__main__':
    original = original_checks()
    records = supplement()
    record = {'kind': 'Independent source-position comparison inputs', 'license': 'New synthetic content and script CC0-1.0',
              'originalOracleCheck': original, 'supplement': records,
              'newStructuralCoordinates': sum(len(r['literalTargets']) for r in records),
              'productionParserExecuted': False, 'workerExecuted': False,
              'boundary': '96 original plus new literal records are original XML structures, not counts of visible/eligible feedback blocks. Production output/qualification is a later independent comparison.'}
    raw = (json.dumps(record, ensure_ascii=False, indent=2) + '\n').encode()
    write_once(OUT / 'oracle-supplement.raw.txt', raw)
    formatted = OUT / 'oracle-supplement.json'
    if formatted.exists():
        assert json.loads(formatted.read_text()) == record
    else:
        formatted.write_bytes(raw)
    print(json.dumps({'originalFilesVerified': original['files'], 'originalStructuralCoordinatesVerified': original['structuralRoundtrips'],
                      'newFixtures': len(records), 'newStructuralCoordinates': record['newStructuralCoordinates'], 'productionParserExecuted': False}))
