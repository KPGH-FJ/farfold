"""Synthetic fixtures only; no user file or account data. Run with bundled Python."""
from pathlib import Path
from io import BytesIO
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.lib.utils import ImageReader
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, ByteStringObject
import reportlab
root = Path(__file__).resolve().parents[3]
out = root / 'src/runtime/fixtures/pdf-preview'
out.mkdir(parents=True, exist_ok=True)
fonts = Path(reportlab.__file__).parent / 'fonts'
pdfmetrics.registerFont(TTFont('FixtureVera', str(fonts / 'Vera.ttf')))
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
c = canvas.Canvas(str(out / 'mixed-two-pages.pdf'), pagesize=(360, 480), invariant=1)
c.setFont('FixtureVera', 19)
c.drawString(28, 430, 'Embedded font and image')
c.setFillColorRGB(0.08, 0.25, 0.55)
c.rect(28, 245, 140, 130, stroke=0, fill=1)
c.drawImage(ImageReader(Image.new('RGB', (40, 30), (220, 120, 30))), 185, 265, 120, 90)
c.showPage()
c.setFont('Helvetica', 20)
c.drawString(28, 430, 'Local standard font')
c.setFillColorRGB(0.1, 0.5, 0.3)
c.circle(160, 270, 60, stroke=0, fill=1)
c.save()
c = canvas.Canvas(str(out / 'unembedded-chinese.pdf'), pagesize=(360, 480), invariant=1)
c.setFont('STSong-Light', 26)
c.drawString(28, 400, '中文预览测试')
c.save()
writer = PdfWriter(); writer.clone_document_from_reader(PdfReader(out / 'mixed-two-pages.pdf'))
writer._ID = ArrayObject([ByteStringObject(b'farfold-fixture00'), ByteStringObject(b'farfold-fixture00')])
writer.encrypt('fixture-password', algorithm='RC4-128')
with (out / 'password.pdf').open('wb') as stream: writer.write(stream)
(out / 'damaged.pdf').write_bytes(b'%PDF-1.7\nnot a document\n')
# One original vector glyph for U+4E2D, embedded as a Type3 font with a ToUnicode map.
glyph = '1000 0 0 0 1000 1000 d1\n90 160 720 640 re 160 230 580 500 re f*\n430 40 80 880 re f'
cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Fixture def /CMapType 2 def 1 begincodespacerange <00> <ff> endcodespacerange 1 beginbfchar <01> <4E2D> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end'
content = 'BT /F1 140 Tf 80 220 Td <01> Tj ET'
objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 480] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', f'<< /Length {len(content)} >>\nstream\n{content}\nendstream', '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /zhong 6 0 R >> /Encoding << /Type /Encoding /Differences [1 /zhong] >> /FirstChar 1 /LastChar 1 /Widths [1000] /Resources << >> /ToUnicode 7 0 R >>', f'<< /Length {len(glyph)} >>\nstream\n{glyph}\nendstream', f'<< /Length {len(cmap)} >>\nstream\n{cmap}\nendstream']
body = '%PDF-1.7\n'; offsets=[]
for i, obj in enumerate(objects):
    offsets.append(len(body)); body += f'{i+1} 0 obj\n{obj}\nendobj\n'
xref = len(body)
body += f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n' + ''.join(f'{x:010} 00000 n \n' for x in offsets)
body += f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'
(out / 'embedded-chinese.pdf').write_bytes(body.encode('ascii'))
(out / 'bitstream-vera-license.txt').write_bytes((fonts / 'bitstream-vera-license.txt').read_bytes())
print({p.name: p.stat().st_size for p in out.glob('*.pdf')})
