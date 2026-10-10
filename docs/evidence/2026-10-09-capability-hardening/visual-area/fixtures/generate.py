"""Authored geometry fixtures. No user document, photograph, fonts or network.
Expected coordinate literals are in the independent plan, not calculated by this
writer. Run with the bundled Python only; does not import Farfold or PDF.js.
"""
from pathlib import Path
from io import BytesIO
from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter
from pypdf.generic import RectangleObject, NameObject, NumberObject
import hashlib, json, importlib.metadata

out = Path(__file__).resolve().parent
buffer = BytesIO()
pdf = canvas.Canvas(buffer, pagesize=(420, 640), invariant=1)
# Deliberately no text or font dependency; all color patches are flat fills.
for angle in (0, 90, 180, 270):
    pdf.setFillColorRGB(0.97, 0.97, 0.97)
    pdf.rect(0, 0, 420, 640, fill=1, stroke=0)
    # Outside-crop black marks must not be visible after CropBox clipping.
    pdf.setFillColorRGB(0, 0, 0)
    pdf.rect(0, 0, 30, 640, fill=1, stroke=0)
    pdf.rect(390, 0, 30, 640, fill=1, stroke=0)
    pdf.setFillColorRGB(1, 1, 1)
    pdf.rect(40, 70, 300, 500, fill=1, stroke=0)
    for x, y, color in (
        (46, 540, (0.9, 0.1, 0.1)),
        (310, 540, (0.1, 0.75, 0.1)),
        (46, 76, (0.1, 0.1, 0.9)),
        (310, 76, (0.9, 0.75, 0.1)),
    ):
        pdf.setFillColorRGB(*color)
        pdf.rect(x, y, 24, 24, fill=1, stroke=0)
    pdf.setFillColorRGB(0.8, 0.05, 0.75)
    pdf.rect(70, 370, 90, 100, fill=1, stroke=0)
    pdf.showPage()
pdf.save()
for unit in (1, 2):
    source = PdfReader(BytesIO(buffer.getvalue()))
    writer = PdfWriter()
    for page, rotation in zip(source.pages, (0, 90, 180, 270)):
        page.cropbox = RectangleObject([40, 70, 340, 570])
        page[NameObject('/Rotate')] = NumberObject(rotation)
        page[NameObject('/UserUnit')] = NumberObject(unit)
        writer.add_page(page)
    writer.add_metadata({'/Title': f'Authored cropped rotation oracle, unit {unit}', '/Author': 'Farfold controlled fixture'})
    with (out / f'crop-rotations-unit{unit}.pdf').open('wb') as f:
        writer.write(f)

image = Image.new('RGB', (320, 200), (245, 245, 245))
draw = ImageDraw.Draw(image)
# Pixel edge intervals; Pillow's final coordinate is inclusive, so subtract 1.
for box, color in (
    ((0, 0, 20, 20), (230, 25, 25)),
    ((300, 0, 320, 20), (25, 190, 25)),
    ((0, 180, 20, 200), (25, 25, 230)),
    ((300, 180, 320, 200), (230, 190, 25)),
    ((32, 40, 128, 100), (204, 13, 191)),
):
    x0, y0, x1, y1 = box
    draw.rectangle((x0, y0, x1-1, y1-1), fill=color)
image.save(out/'asymmetric.png')
image.save(out/'asymmetric-static.webp', lossless=True)
image.save(out/'asymmetric-static.gif')
for orientation in range(1, 9):
    exif = Image.Exif()
    exif[274] = orientation
    image.save(out/f'asymmetric-exif-{orientation}.jpg', quality=97, subsampling=0, exif=exif)

files = []
for path in sorted(out.iterdir()):
    if path.suffix not in ('.pdf','.png','.jpg','.gif','.webp'):
        continue
    data = path.read_bytes()
    files.append({'path': path.name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
manifest = {
    'kind': 'new independently authored geometry fixture material; not a renderer test receipt',
    'license': 'Original synthetic shapes and colors created for Farfold testing; no third-party document, image or font material.',
    'writers': {name: importlib.metadata.version(name) for name in ('reportlab','pypdf','Pillow')},
    'pdf': {'mediaBox':[0,0,420,640], 'cropBox':[40,70,340,570], 'rotations':[0,90,180,270], 'userUnits':[1,2], 'featureRawRect':[70,370,160,470], 'rawOrigin':'bottom-left; x right, y up', 'cornerOrderTopLeftTopRightBottomLeftBottomRight':['red','green','blue','yellow']},
    'raster': {'rawSize':[320,200], 'featureRawEdgeRect':[32,40,128,100], 'rawOrigin':'top-left; x right, y down', 'exifTag':274, 'orientations':list(range(1,9)), 'cornerOrderTopLeftTopRightBottomLeftBottomRight':['red','green','blue','yellow']},
    'expectations': 'Literal expected millionth boxes are frozen separately in visual-area/independent-plan.json. Generator does not derive expected coordinates from rendered output.',
    'files': files,
}
(out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'files':len(files),'writers':manifest['writers'],'pdfPages':8,'rasterDirections':8}))
