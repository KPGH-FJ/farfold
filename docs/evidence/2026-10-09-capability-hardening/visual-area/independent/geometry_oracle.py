"""Independent literal/fraction geometry preparation; imports no Farfold code.
No files, images, App or renderer are opened by this calculation.
"""
from fractions import Fraction as F
import json

SCALE = 1_000_000
PDF_LITERAL = {
    0: [100000, 200000, 400000, 400000],
    90: [600000, 100000, 800000, 400000],
    180: [600000, 600000, 900000, 800000],
    270: [200000, 600000, 400000, 900000],
}
EXIF_LITERAL = {
    1: [100000, 200000, 400000, 500000],
    2: [600000, 200000, 900000, 500000],
    3: [600000, 500000, 900000, 800000],
    4: [100000, 500000, 400000, 800000],
    5: [200000, 100000, 500000, 400000],
    6: [500000, 100000, 800000, 400000],
    7: [500000, 600000, 800000, 900000],
    8: [200000, 600000, 500000, 900000],
}

def corners(box):
    left, top, right, bottom = box
    return [(x, y) for x in (left, right) for y in (top, bottom)]

def bound(points):
    xs, ys = zip(*points)
    values = [min(xs), min(ys), max(xs), max(ys)]
    assert all((value * SCALE).denominator == 1 for value in values)
    return [int(value * SCALE) for value in values]

# Raw PDF crop-relative u right, v UP. No PageViewport call is used.
pdf_transforms = {
    0: lambda u, v: (u, 1-v),
    90: lambda u, v: (v, u),
    180: lambda u, v: (1-u, v),
    270: lambda u, v: (1-v, 1-u),
}
pdf_corners = [(F(x-40, 300), F(y-70, 500))
               for x in (70, 160) for y in (370, 470)]
for angle, transform in pdf_transforms.items():
    assert bound([transform(*p) for p in pdf_corners]) == PDF_LITERAL[angle]

# Raw JPEG u right, v DOWN. CIPA Orientation tag's row/column directions.
exif_transforms = {
    1: lambda u, v: (u, v),
    2: lambda u, v: (1-u, v),
    3: lambda u, v: (1-u, 1-v),
    4: lambda u, v: (u, 1-v),
    5: lambda u, v: (v, u),
    6: lambda u, v: (1-v, u),
    7: lambda u, v: (1-v, 1-u),
    8: lambda u, v: (v, 1-u),
}
raw = corners((F(1, 10), F(1, 5), F(2, 5), F(1, 2)))
for tag, transform in exif_transforms.items():
    assert bound([transform(*p) for p in raw]) == EXIF_LITERAL[tag]

# A deliberate padded/letterboxed surface, not a claim about current CSS.
# Stage (100,50,500,420), border2+padding18, inside460x380; 2:1 image.
content = (F(120), F(145), F(460), F(230))
screen = [(content[0] + x*content[2], content[1] + y*content[3]) for x,y in raw]
assert bound([((x-content[0])/content[2], (y-content[1])/content[3]) for x,y in screen]) == EXIF_LITERAL[1]
assert [int(screen[0][0]), int(screen[0][1]), int(screen[-1][0]), int(screen[-1][1])] == [166,191,304,260]
# Canvas backing DPR has no place in screen/CSS normalization.
for dpr in (F(1), F(5,4), F(2)):
    backing = (content[2]*dpr, content[3]*dpr)
    assert bound([((x-content[0])/content[2], (y-content[1])/content[3]) for x,y in screen]) == EXIF_LITERAL[1]
    assert backing[0]/backing[1] == F(2)

print(json.dumps({
    "kind": "pure independent rational oracle self-check, not product validation",
    "status": "passed",
    "literalRectangleChecks": 12,
    "letterboxCheck": 1,
    "dprCases": [1, 1.25, 2],
    "pdfCrop": [40,70,340,570],
    "pdfRawRect": [70,370,160,470],
    "pdf": PDF_LITERAL,
    "jpegRawDimensions": [320,200],
    "jpegRawRect": [32,40,128,100],
    "exif": EXIF_LITERAL,
    "contentCssRect": [120,145,460,230],
    "pointerCssRect": [166,191,304,260],
    "noRendererOrProductionImports": True,
}, indent=2) + "\n", end="")
