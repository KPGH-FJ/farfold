"""Deterministically frame the user's existing rounded Farfold artwork.

Authorized by the user: retain original artwork; programmatic corners and margin.
Only the six production icons listed below and this evidence directory are written.
"""

from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
import hashlib
import json
import struct

from PIL import Image, __version__ as pillow_version


ROOT = Path(__file__).resolve().parents[4]
EVIDENCE = Path(__file__).resolve().parent
SOURCE = Path(
    "/Users/tw/Desktop/视觉/Farfold/Farfold_Visual_Identity_v0.1/"
    "02_App_Icons/Previews/farfold-app-rounded-light.png"
)
SOURCE_SHA256 = "16d88b0f948be4ceac218b10bbd57460dbdad8f711c44e222082418e46419aec"
ICONS = ROOT / "src-tauri/icons"
OUTPUTS = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 1024,
}
ICNS_SIZES = {
    "ic07": 128,
    "ic08": 256,
    "ic09": 512,
    "ic10": 1024,
    "ic11": 32,
    "ic12": 64,
    "ic13": 256,
    "ic14": 512,
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pixels(im):
    rgba = im.convert("RGBA")
    width, height = rgba.size
    alpha = rgba.getchannel("A")
    corners = [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]
    return {
        "size": list(rgba.size),
        "mode": rgba.mode,
        "pixelSha256": sha(rgba.tobytes()),
        "alphaRange": list(alpha.getextrema()),
        "alphaBBox": list(alpha.getbbox()),
        "cornerAlpha": [alpha.getpixel(point) for point in corners],
        "outerEdgesFullyTransparent": all(
            alpha.crop(box).getextrema() == (0, 0)
            for box in [
                (0, 0, width, 1),
                (0, height - 1, width, height),
                (0, 0, 1, height),
                (width - 1, 0, width, height),
            ]
        ),
    }


source_bytes = SOURCE.read_bytes()
assert sha(source_bytes) == SOURCE_SHA256, "User-supplied source has changed"
source = Image.open(BytesIO(source_bytes)).convert("RGBA")
assert source.size == (1024, 1024)
baseline_path = ROOT / "docs/evidence/2026-10-03-visible-removal-icon/source-after-build.json"
baseline = json.loads(baseline_path.read_text())["source"]["files"]
before = {name: baseline[f"src-tauri/icons/{name}"] for name in [*OUTPUTS, "icon.icns"]}
artwork = source.resize((824, 824), Image.Resampling.LANCZOS)
master = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
master.paste(artwork, (100, 100))
assert master.crop((100, 100, 924, 924)).tobytes() == artwork.tobytes()
assert master.getchannel("A").getbbox() == (100, 100, 924, 924)

rendered = {1024: master}
for size in [32, 64, 128, 256, 512]:
    resized = master.resize((size, size), Image.Resampling.LANCZOS)
    margin = size * 100 // 1024
    # Keep the intended outer canvas transparent: Lanczos can otherwise leave
    # alpha=1 ringing outside the source artwork, including 32px outer edges.
    framed = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    framed.paste(resized.crop((margin, margin, size - margin, size - margin)), (margin, margin))
    rendered[size] = framed
for name, size in OUTPUTS.items():
    rendered[size].save(ICONS / name, format="PNG")
master.save(
    ICONS / "icon.icns",
    format="ICNS",
    append_images=[rendered[size] for size in [32, 64, 128, 256, 512]],
)
master.save(EVIDENCE / "preview.png", format="PNG")

outputs = {}
for name, size in OUTPUTS.items():
    path = ICONS / name
    details = pixels(Image.open(path))
    assert details["size"] == [size, size]
    assert details["outerEdgesFullyTransparent"]
    assert details["cornerAlpha"] == [0, 0, 0, 0]
    outputs[name] = {"sha256": sha(path.read_bytes()), **details}

icns = (ICONS / "icon.icns").read_bytes()
assert icns[:4] == b"icns" and struct.unpack(">I", icns[4:8])[0] == len(icns)
offset = 8
representations = {}
while offset < len(icns):
    tag_bytes, length = struct.unpack(">4sI", icns[offset : offset + 8])
    assert length >= 8 and offset + length <= len(icns)
    tag = tag_bytes.decode("ascii")
    payload = icns[offset + 8 : offset + length]
    if tag != "TOC ":
        assert tag in ICNS_SIZES and tag not in representations
        image = Image.open(BytesIO(payload)).convert("RGBA")
        details = pixels(image)
        assert details["size"] == [ICNS_SIZES[tag], ICNS_SIZES[tag]]
        assert details["outerEdgesFullyTransparent"]
        assert image.tobytes() == rendered[ICNS_SIZES[tag]].tobytes()
        representations[tag] = {"sha256": sha(payload), **details}
    offset += length
assert offset == len(icns) and set(representations) == set(ICNS_SIZES)
assert Image.open(ICONS / "icon.icns").convert("RGBA").tobytes() == master.tobytes()
assert sha(SOURCE.read_bytes()) == SOURCE_SHA256

receipt = {
    "atUtc": datetime.now(timezone.utc).isoformat(),
    "scope": "Programmatic framing of existing user-supplied artwork; no app install or system changes",
    "authorization": "使用原始素材，仅程序化调整圆角和留白（推荐）",
    "source": {"path": str(SOURCE), "sha256": SOURCE_SHA256, **pixels(source)},
    "transform": {
        "canvas": [1024, 1024],
        "artworkSize": [824, 824],
        "offset": [100, 100],
        "scale": 824 / 1024,
        "transparentMargin": 100,
        "filter": "Pillow LANCZOS",
        "scaledMarginClipsResamplingRinging": True,
        "pillowVersion": pillow_version,
        "logoPathsColorsAndGradientsEdited": False,
        "roundedBackgroundPreservedFromSource": True,
    },
    "productionBefore": before,
    "productionBeforeSource": str(baseline_path.relative_to(ROOT)),
    "productionAfter": outputs,
    "icns": {"sha256": sha(icns), "representationCount": len(representations), "representations": representations},
    "preview": {"file": "preview.png", "sha256": sha((EVIDENCE / "preview.png").read_bytes())},
    "sourceUnchanged": True,
    "publicBrandAssetsEdited": False,
    "applicationBuiltOrInstalled": False,
    "systemIconRegistrationChanged": False,
}
(EVIDENCE / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"writtenProductionIcons": 6, "icnsRepresentations": len(representations), "masterAlphaBBox": pixels(master)["alphaBBox"], "evidence": str(EVIDENCE)}))
