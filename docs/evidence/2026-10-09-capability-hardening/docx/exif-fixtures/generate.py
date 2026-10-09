"""Complete DOCX with public authored asymmetric EXIF6 JPEG, for real file reads."""
from pathlib import Path
import zipfile, json, hashlib, re
folder = Path(__file__).resolve().parent
base = folder.parents[1]
source = base / 'docx-fixtures/05-inline-png-jpeg.docx'
image = folder.parent / 'browser/authored-orientation-6.jpg'
output = folder / 'asymmetric-exif6.docx'
with zipfile.ZipFile(source) as archive:
    parts = {name: archive.read(name) for name in archive.namelist()}
image_name = next(name for name in parts if name.endswith('.jpg'))
parts[image_name] = image.read_bytes()
xml = parts['word/document.xml'].decode()
drawings = re.findall(r'<w:drawing>[\s\S]*?</w:drawing>', xml)
assert len(drawings) == 2
# This fixture's second drawing is the JPEG; retain a 3:2 display frame after rotation.
updated = re.sub(r'cx="\d+" cy="\d+"', 'cx="1371600" cy="914400"', drawings[1])
xml = xml.replace(drawings[1], updated)
parts['word/document.xml'] = xml.encode()
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for name, data in parts.items():
        info = zipfile.ZipInfo(name, (2026, 10, 9, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, data)
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
receipt = dict(file=output.name, sha256=hashlib.sha256(output.read_bytes()).hexdigest(), bytes=output.stat().st_size, publicAuthored=True, originalJpegSof=[80,120], exifOrientation=6, expectedDecodedDimensions=[120,80], expectedJpegQuadrants=['blue','red','yellow','green'], quadrantOrder='top-left, top-right, bottom-left, bottom-right', drawingFrameEmu=[1371600,914400], source='Existing public authored 05 DOCX plus Pillow-authored four-color JPEG. Original fixture preserved.', executed=False, qualification='Prepared complete ZIP/CRC-valid DOCX; real native file delivery not executed by this subagent.')
(folder / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
