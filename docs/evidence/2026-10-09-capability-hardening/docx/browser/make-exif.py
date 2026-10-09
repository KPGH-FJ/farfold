"""Public authored asymmetric raster; no user photograph."""
from pathlib import Path
from PIL import Image
import json, base64
folder = Path(__file__).resolve().parent
image = Image.new('RGB', (80, 120))
for y in range(120):
    for x in range(80):
        image.putpixel((x, y), [(220, 20, 20), (20, 200, 20), (20, 20, 220), (220, 200, 20)][(y >= 60) * 2 + (x >= 40)])
image.save(folder / 'authored-portrait.jpg', format='JPEG', quality=95, subsampling=0)
variants = []
for orientation in range(1, 9):
    exif = Image.Exif()
    exif[274] = orientation
    path = folder / f'authored-orientation-{orientation}.jpg'
    image.save(path, format='JPEG', quality=95, subsampling=0, exif=exif)
    variants.append(dict(orientation=orientation, base64=base64.b64encode(path.read_bytes()).decode()))
(folder / 'exif-variants.json').write_text(json.dumps(variants, separators=(',', ':')) + '\n')
