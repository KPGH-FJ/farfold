"""Original public PDF inputs and raw-content oracle, not a production parser."""
from pathlib import Path
import hashlib
import io
import json
import zlib
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, ByteStringObject

HERE = Path(__file__).resolve().parent


def sha(data):
    return hashlib.sha256(data).hexdigest()


def exclusive(path, data):
    with path.open('xb') as handle:
        handle.write(data)


def pdf(objects):
    body = bytearray(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
    offsets = [0]
    for index, value in enumerate(objects, 1):
        value = value.encode('ascii') if isinstance(value, str) else value
        offsets.append(len(body))
        body.extend(f'{index} 0 obj\n'.encode() + value + b'\nendobj\n')
    xref = len(body)
    body.extend(f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:
        body.extend(f'{offset:010d} 00000 n \n'.encode())
    body.extend(f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    return bytes(body)


def stream(value, extra=''):
    value = value.encode('ascii') if isinstance(value, str) else value
    return f'<< /Length {len(value)} {extra} >>\nstream\n'.encode() + value + b'\nendstream'


def text(value, x, y, mode=0):
    assert '(' not in value and ')' not in value and '\\' not in value
    return f'BT /F1 14 Tf {mode} Tr 1 0 0 1 {x} {y} Tm ({value}) Tj ET\n'


records = {}


def record(name, objects, oracle, raw_streams):
    data = pdf(objects)
    exclusive(HERE / 'fixtures' / name, data)
    content_refs = []
    for key, value in raw_streams.items():
        value = value.encode('ascii') if isinstance(value, str) else value
        filename = name.removesuffix('.pdf') + '-' + key + '.bin'
        exclusive(HERE / 'raw-content' / filename, value)
        content_refs.append({'path': 'raw-content/' + filename, 'sha256': sha(value), 'bytes': len(value)})
    oracle.update({'path': 'fixtures/' + name, 'sha256': sha(data), 'bytes': len(data), 'rawContentRefs': content_refs})
    records[name] = oracle
    return data


page_one = text('PAGE_ONE_VISIBLE', 35, 660)
page_one += text('INVISIBLE_TR3', 35, 620, 3)
page_one += 'q /GS0 gs\n' + text('ZERO_ALPHA', 35, 580) + 'Q\n'
page_one += 'q 1 1 1 rg\n' + text('WHITE_ON_WHITE', 35, 540) + 'Q\n'
page_one += 'q 0 0 1 1 re W n\n' + text('LOCAL_CLIP_HIDDEN', 35, 500) + 'Q\n'
page_one += text('OUTSIDE_CROP', 400, 460)
page_one += '/OC /Layer1 BDC\n' + text('OFF_LAYER_TEXT', 35, 420) + 'EMC\n'
page_two = 'q 96 0 0 96 100 200 cm /Im1 Do Q\n'
page_two += text('PAGE_TWO_ROTATED', 35, 660)
page_two += text('OCR_LABEL_NOT_ON_IMAGE', 35, 180, 3)
page_three = text('PAGE_THREE_TAIL', 35, 660)
resources = '/Font << /F1 9 0 R >> /ExtGState << /GS0 10 0 R >> /Properties << /Layer1 11 0 R >> /XObject << /Im1 12 0 R >>'
pixels = bytes([255, 40, 20, 20, 80, 255] * 32)
main_objects = [
    '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [11 0 R] /D << /BaseState /ON /OFF [11 0 R] >> >> /OpenAction 13 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>',
    f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /CropBox [0 0 300 700] /Resources << {resources} >> /Contents 4 0 R >>',
    stream(page_one),
    f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Rotate 90 /Resources << {resources} >> /Contents 6 0 R >>',
    stream(page_two),
    f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << {resources} >> /Contents 8 0 R >>',
    stream(page_three),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /ExtGState /ca 0 /CA 0 >>',
    '<< /Type /OCG /Name (Owned off layer) >>',
    stream(zlib.compress(pixels), '/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode'),
    '<< /S /JavaScript /JS (throw new Error\(OWNED_PDF_SCRIPT_MUST_NOT_RUN\)) >>',
]
main = record('01-pages-hidden-crop-ocr.pdf', main_objects, {
    'kind': 'positiveDecodedTextWithExplicitScope', 'pageCount': 3,
    'sourceTokensByPage': [
        ['PAGE_ONE_VISIBLE','INVISIBLE_TR3','ZERO_ALPHA','WHITE_ON_WHITE','LOCAL_CLIP_HIDDEN','OUTSIDE_CROP','OFF_LAYER_TEXT'],
        ['PAGE_TWO_ROTATED','OCR_LABEL_NOT_ON_IMAGE'], ['PAGE_THREE_TAIL']],
    'pageRotations': [0,90,0],
    'visibilityFromAuthoring': {'PAGE_ONE_VISIBLE':'visible','INVISIBLE_TR3':'Tr=3, invisible','ZERO_ALPHA':'alpha=0','WHITE_ON_WHITE':'white on white','LOCAL_CLIP_HIDDEN':'outside local 1x1 clip','OUTSIDE_CROP':'inside MediaBox but outside CropBox','OFF_LAYER_TEXT':'OCG default OFF','OCR_LABEL_NOT_ON_IMAGE':'invisible saved label, not words depicted by the bitmap'},
    'rawContentOracle': 'All listed tokens are physically saved PDF strings. API extraction may omit OUTSIDE_CROP; do not label the result all stored strings or visible text. No script may execute.',
    'independentExpectedVisual': ['page1 only PAGE_ONE_VISIBLE','page2 rotated PAGE_TWO_ROTATED and a colored 8x8 raster; no OCR label','page3 PAGE_THREE_TAIL'],
    'claimLimits': ['No OCR accuracy claim','No guaranteed visual visibility or human reading order'],
}, {'page1':page_one,'page2':page_two,'page3':page_three})

cmap = '''/CIDInit /ProcSet findresource begin
12 dict begin begincmap
/CIDSystemInfo << /Registry (Owned) /Ordering (Unicode) /Supplement 0 >> def
/CMapName /OwnedUnicode def /CMapType 2 def
1 begincodespacerange <00> <FF> endcodespacerange
4 beginbfchar <41> <00660069> <42> <FB01> <43> <4E2D> <44> <D83DDE80> endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end
'''
glyph = '600 0 0 0 600 700 d1 50 50 450 600 re S 275 50 m 275 650 l S 50 350 m 500 350 l S'
type3 = '/Type /Font /Subtype /Type3 /Name /OwnedGlyph /FontBBox [0 0 600 700] /FontMatrix [.001 0 0 .001 0 0] /CharProcs << /g 7 0 R >> /Encoding << /Type /Encoding /Differences [65 /g /g /g /g] >> /FirstChar 65 /LastChar 68 /Widths [600 600 600 600] /Resources << >>'
encoded = 'BT /F1 24 Tf 30 650 Td <41424344> Tj ET\nBT /F2 24 Tf 30 580 Td <43> Tj ET\n'
record('02-encoding-ligature-unmapped.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    stream(encoded), f'<< {type3} /ToUnicode 8 0 R >>', f'<< {type3} >>', stream(glyph), stream(cmap)], {
    'kind':'encodedPositiveAndUnknownMapping','pageCount':1,
    'rawCodes':[{'font':'F1','hex':'41424344','unicodeMapping':['fi','\ufb01','\u4e2d','\U0001f680']},{'font':'F2','hex':'43','unicodeMapping':None}],
    'expectedMappedText':'fi\ufb01\u4e2d\U0001f680',
    'expectedMappedTextUtf8Bytes':len('fi\ufb01\u4e2d\U0001f680'.encode()),
    'claimLimits':['disableNormalization=true preserves mapped ligature if parser does','F2 has no Unicode map; never assert visual glyph meaning from fallback returned code','No Unicode normalization, OCR or guessed replacement'],
}, {'page1':encoded,'to-unicode':cmap,'glyph':glyph})

image_only = 'q 160 0 0 160 50 100 cm /Im1 Do Q\n'
record('03-image-only.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    stream(image_only), stream(zlib.compress(pixels), '/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode')], {
    'kind':'noTextNegative','pageCount':1,'sourceTokensByPage':[[]],
    'expectedInputResult':'noText; no confirm; original draft preserved; no OCR invoked',
}, {'page1':image_only})

writer = PdfWriter()
writer.clone_document_from_reader(PdfReader(io.BytesIO(main)))
writer._ID = ArrayObject([ByteStringObject(b'OWNED-PDF-FIXTURE-20261013'),ByteStringObject(b'OWNED-PDF-FIXTURE-20261013')])
writer.encrypt('fixture-password', 'fixture-owner', algorithm='RC4-128')
buffer = io.BytesIO()
writer.write(buffer)
encrypted = buffer.getvalue()
exclusive(HERE / 'fixtures/04-encrypted.pdf', encrypted)
records['04-encrypted.pdf'] = {'kind':'encryptionNegative','path':'fixtures/04-encrypted.pdf','sha256':sha(encrypted),'bytes':len(encrypted),'pageCount':3,'expectedInputResult':'encrypted; no password prompt/persistence; original draft preserved','publicTestOnlyPassword':'fixture-password','derivedOnlyFromOwnFixture':'01-pages-hidden-crop-ocr.pdf'}

late_a = text('GOOD_FIRST_PAGE_NOT_SUCCESS',30,650)
late_c = text('GOOD_THIRD_PAGE_NOT_SUCCESS',30,650)
bad = b'not-a-valid-zlib-stream'
record('05-late-page-damaged.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /F1 9 0 R >> >> /Contents 4 0 R >>',stream(late_a),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /F1 9 0 R >> >> /Contents 6 0 R >>',stream(bad,'/Filter /FlateDecode'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /F1 9 0 R >> >> /Contents 8 0 R >>',stream(late_c),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'], {
    'kind':'lateFailureNegative','pageCount':3,'invalidPart':'page2 stream claims FlateDecode but bytes are invalid','sourceTokensByPage':[['GOOD_FIRST_PAGE_NOT_SUCCESS'],[],['GOOD_THIRD_PAGE_NOT_SUCCESS']],
    'expectedInputResult':'invalid/incomplete whole read; no prefix/suffix success and no confirm; warning must invalidate even if strict promise resolves',
}, {'page1':late_a,'page2-invalid':bad,'page3':late_c})

long_page = ''.join(text('A'*100,30,650) for _ in range(1500))
record('06-whole-utf8-over-limit.pdf', [
    '<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1600 700] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',stream(long_page),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1600 700] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',stream(long_page),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'], {
    'kind':'wholeUtf8LimitNegative','pageCount':2,'savedASCIITextBytesPerPage':150000,'savedASCIITextBytesTotal':300000,
    'expectedInputResult':'textLimit on global whole text including generated structure; never per-page reset, truncation or first-page success',
    'independentExpectedVisual':'1500 overlapping same-position lines per page are intentional, not a polished document',
}, {'page1':long_page,'page2':long_page})

oracle = {'schema':1,'purpose':'Independent raw authoring facts and required semantics. Not generated from production parser or future implementation.','fixtures':records,'appAgentUserDataAccessed':False}
exclusive(HERE / 'independent-oracle.json', (json.dumps(oracle,ensure_ascii=False,indent=2)+'\n').encode())
print(json.dumps({'fixtures':len(records),'bytes':sum(item['bytes'] for item in records.values()),'oracleSha256':sha((HERE/'independent-oracle.json').read_bytes())}))
