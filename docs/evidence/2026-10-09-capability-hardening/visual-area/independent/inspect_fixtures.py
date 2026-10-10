from pathlib import Path
from PIL import Image, ImageOps, ImageDraw
from pypdf import PdfReader
import json, hashlib
root=Path.cwd(); base=root/'docs/evidence/2026-10-09-capability-hardening/visual-area'; out=root/'output/2026-10-10-visual-area-independent'
expected=json.loads((out/'geometry-oracle.json').read_text()); checks=[]; tiles=[]
def examine(path, rect, name):
    image=Image.open(path).convert('RGB'); w,h=image.size
    pixels=image.load(); xs=[];ys=[]
    for y in range(h):
        for x in range(w):
            r,g,b=pixels[x,y]
            if r>150 and b>140 and g<60: xs.append(x);ys.append(y)
    assert xs, name
    found=[min(xs),min(ys),max(xs)+1,max(ys)+1]
    desired=[rect[0]*w/1e6,rect[1]*h/1e6,rect[2]*w/1e6,rect[3]*h/1e6]
    maxerror=max(abs(a-b) for a,b in zip(found,desired)); assert maxerror<=1.01,(name,found,desired)
    checks.append({'case':name,'actualSize':[w,h],'actualMarkerEdgeRect':found,'expectedPixelEdgeRect':desired,'maximumEdgeErrorPixels':maxerror})
    image.thumbnail((220,220)); tile=Image.new('RGB',(240,250),'#ddd'); tile.paste(image,((240-image.width)//2,22)); ImageDraw.Draw(tile).text((4,234),name,fill='black'); tiles.append(tile)
for unit in (1,2):
    pdf=PdfReader(base/'fixtures'/f'crop-rotations-unit{unit}.pdf'); assert len(pdf.pages)==4
    for n,rotation in enumerate((0,90,180,270),1):
        page=pdf.pages[n-1]; assert list(page.cropbox)==[40,70,340,570];assert page.rotation==rotation;assert page.user_unit==unit
        examine(out/'rendered'/f'unit{unit}-{n}.png',expected['pdf'][str(rotation)],f'PDF u{unit} / {rotation}')
for tag in range(1,9):
    path=base/'fixtures'/f'asymmetric-exif-{tag}.jpg'; raw=Image.open(path)
    assert raw.size==(320,200) and raw.getexif()[274]==tag
    displayed=ImageOps.exif_transpose(raw); assert displayed.size==((320,200) if tag<=4 else (200,320))
    rendered=out/'rendered'/f'exif-{tag}.png';displayed.save(rendered)
    examine(rendered,expected['exif'][str(tag)],f'EXIF {tag} (Pillow reference)')
canvas=Image.new('RGB',(240*4,250*4),'white')
for i,tile in enumerate(tiles):canvas.paste(tile,((i%4)*240,(i//4)*250))
canvas.save(out/'rendered'/'geometry-contact-sheet.png')
result={'kind':'independent fixture structure and reference-render check, not Farfold or browser validation','status':'passed','pdfRenderer':'Poppler pdftoppm -cropbox -r72','imageReference':'Pillow ImageOps.exif_transpose only; actual browser decode remains untested','checks':checks,'warning':'Poppler actual size is reported, not used as the expected normalized oracle. UserUnit behavior may differ by renderer and is separately tested later in production PDF.js.'}
(base/'independent'/'fixture-reference-check.json').write_text(json.dumps(result,indent=2)+'\n');print({'status':'passed','checks':len(checks),'contactSheet':str(out/'rendered'/'geometry-contact-sheet.png')})
