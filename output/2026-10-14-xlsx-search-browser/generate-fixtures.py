"""Author synthetic XLSX and independent expected search segments; no production parser."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
ROOT = Path('/Users/tw/Desktop/farfold')
OUT = Path(__file__).parent
GENERATOR = ROOT / 'docs/evidence/2026-10-09-capability-hardening/xlsx-input/fixtures/make-fixtures.py'
spec = importlib.util.spec_from_file_location('existing_synthetic_ooxml_author', GENERATOR)
factory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(factory)


def write(path, raw):
    with path.open('xb') as handle:
        handle.write(raw)


def save_json(name, data):
    write(OUT / name, (json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode())


def capture(name, parts):
    raw = factory.archive(parts)
    write(OUT / name, raw)
    path = '/controlled/' + name
    return {'file': {'root': '/controlled', 'path': path, 'resolvedPath': path, 'name': name,
                     'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'version': 'controlled-' + name},
            'parts': [{'name': key, 'data': base64.b64encode(value).decode()} for key, value in parts.items() if key.endswith(('.xml', '.rels'))],
            'entries': list(parts), 'inflatedBytes': sum(len(value) for value in parts.values())}


def primary():
    row = '<row r="1">' + ''.join([
        '<c r="A1" t="s"><v>0</v></c>',
        '<c r="B1"><v>12345678901234567890.000100</v></c>',
        '<c r="C1" t="b"><v>0</v></c>',
        '<c r="D1" t="e"><v>#DIV/0!</v></c>',
        '<c r="E1" t="d"><v>2026-10-14T00:00:00Z</v></c>',
        '<c r="F1" t="str"><f>"needle formula-only"</f><v>needle cached-result</v></c>',
        factory.inline('G1', 'LEFT'), factory.inline('H1', 'RIGHT'),
        '<c r="I1"><f>NO_CACHE_FORMULA</f></c>',
        '<c r="J1" t="str"><f>EMPTY_CACHE_FORMULA</f><v/></c>',
        '<c r="K1"><f>0</f><v>0</v></c>',
        '<c r="L1"><f t="shared" si="4"/><v>8</v></c>',
    ]) + '</row>'
    row += '<row r="2" hidden="1">' + factory.inline('A2', 'HIDDEN_ROW_NEVER') + '</row>'
    row += '<row r="3">' + factory.inline('Z3', 'HIDDEN_COLUMN_NEVER') + '</row>'
    row += '<row r="5">' + factory.inline('A5', 'needle <img src="https://example.invalid/XLSX">') + '</row>'
    sst = '<sst xmlns="' + factory.MAIN + '" count="1" uniqueCount="1"><si><r><t>nee</t></r><r><t>dle 汉😀é</t></r></si></sst>'
    parts = factory.package([
        ('SHEET_LABEL_NEVER', 'visible', factory.worksheet(row, '<cols><col min="26" max="26" hidden="1"/></cols>')),
        ('Later', 'visible', factory.worksheet('<row r="1">' + factory.inline('A1', 'second sheet needle') + '</row>')),
        ('Hidden', 'hidden', factory.worksheet('<row r="1">' + factory.inline('A1', 'HIDDEN_SHEET_NEVER') + '</row>')),
    ], sst=sst)
    parts['xl/workbook.xml'] = parts['xl/workbook.xml'].replace(b'sheetId="1"', b'sheetId="17"').replace(b'sheetId="3"', b'sheetId="91"').replace(b'sheetId="2"', b'sheetId="3"')
    return parts


def main():
    parts = primary()
    captures = [capture('author.xlsx', parts), capture('second.xlsx', {key: value.replace(b'needle', b'secondterm') for key, value in parts.items()})]
    # Expected strings are authored separately from XML and never derived by the parser.
    entries = [
        ('rId1', 'A1', 'value', 'needle 汉😀é'),
        ('rId1', 'B1', 'value', '12345678901234567890.000100'),
        ('rId1', 'C1', 'value', '0'), ('rId1', 'D1', 'value', '#DIV/0!'),
        ('rId1', 'E1', 'value', '2026-10-14T00:00:00Z'),
        ('rId1', 'F1', 'formula', '"needle formula-only"'), ('rId1', 'F1', 'savedCache', 'needle cached-result'),
        ('rId1', 'G1', 'value', 'LEFT'), ('rId1', 'H1', 'value', 'RIGHT'),
        ('rId1', 'I1', 'formula', 'NO_CACHE_FORMULA'), ('rId1', 'J1', 'formula', 'EMPTY_CACHE_FORMULA'),
        ('rId1', 'K1', 'formula', '0'), ('rId1', 'K1', 'savedCache', '0'), ('rId1', 'L1', 'savedCache', '8'),
        ('rId1', 'A5', 'value', 'needle <img src="https://example.invalid/XLSX">'),
        ('rId2', 'A1', 'value', 'second sheet needle'),
    ]
    oracle = {'scope': 'Authored strings and locations, no production parser or formula evaluation; native I/O and installed App untested.',
              'generatorSha256': hashlib.sha256(GENERATOR.read_bytes()).hexdigest(),
              'segments': [{'sheetId': sheet, 'reference': cell, 'field': field, 'text': text} for sheet, cell, field, text in entries],
              'authorBytes': sum(len(text.encode()) for _, _, _, text in entries), 'authorNeedleCount': 5,
              'secondNeedleCount': 1, 'secondTermCount': 4,
              'negativeTerms': ['HIDDEN_ROW_NEVER', 'HIDDEN_COLUMN_NEVER', 'HIDDEN_SHEET_NEVER', 'SHEET_LABEL_NEVER', 'LEFTRIGHT', 'formula-only"needle cached-result', 'date1904', 'savedFormulaCaches'],
              'files': [item['file'] for item in captures]}
    oracle['sheetIdMeaning'] = 'Existing validated workbook sheet.id is the declared relationship r:id; numeric OOXML sheetId values remain 17/3/91 and are not application lookup keys.'
    save_json('captures.json', captures)
    save_json('oracle.json', oracle)
    # 3M Han characters = 9M UTF-8 bytes, below existing character and XML-part limits.
    text = '汉' * 3_000_000 + ' needle'
    budget_parts = factory.package([('Budget', 'visible', factory.worksheet('<row r="1">' + factory.inline('A1', text) + '</row>'))])
    budget = [capture('budget-a.xlsx', budget_parts), capture('budget-b.xlsx', budget_parts)]
    save_json('budget-captures.json', budget)
    save_json('budget-oracle.json', {'authorUtf8BytesPerFile': len(text.encode()), 'compressedBytes': [item['file']['size'] for item in budget], 'retainedFirstFileNeedleCount': 1, 'otherLargeFileSkippedAsBudget': True})
    print(json.dumps({'files': 4, 'authorNeedleCount': 5, 'authorUtf8Bytes': oracle['authorBytes'], 'budgetPerFileUtf8Bytes': len(text.encode())}))


if __name__ == '__main__':
    main()
