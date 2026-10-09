#!/usr/bin/env python3
"""Check the fixture corpus itself, not Farfold or Word rendering.

Standard library for ZIP/XML checks; optional --pixels uses bundled Pillow.
Reads each archive serially and never extracts files or follows relationships.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import pathlib
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile
import zlib

ROOT = pathlib.Path(__file__).resolve().parent
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W, "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
MIB = 1024 * 1024


def check(condition, description):
    if not condition:
        raise AssertionError(description)


def part(case, name):
    with zipfile.ZipFile(ROOT / case["file"]) as z:
        return z.read(name)


def body(case):
    return ET.fromstring(part(case, "word/document.xml")).find("w:body", NS)


def verify(pixels=False):
    manifest = json.loads((ROOT / "manifest.json").read_text())
    checks = []

    def passed(name, details=None):
        checks.append({"check": name, "passed": True, "details": details})

    cases = {c["id"]: c for c in manifest["cases"]}
    check(len(cases) == manifest["fixtureCount"] == 28, "fixture identity/count")
    passed("manifest-case-identities", 28)
    for case in cases.values():
        raw = (ROOT / case["file"]).read_bytes()
        check(len(raw) == case["archiveBytes"], "archive size")
        check(hashlib.sha256(raw).hexdigest() == case["sha256"], "archive hash")
        observed_total = 0
        observed_max = 0
        xml_count = 0
        crc_error = False
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            infos = z.infolist()
            check(len(infos) == case["entryCount"], "entry count")
            for info, expected in zip(infos, case["sourceParts"]):
                check(info.filename == expected["name"], "entry order/name")
                size = 0
                digest = hashlib.sha256()
                xml_data = bytearray()
                try:
                    with z.open(info) as stream:
                        while True:
                            chunk = stream.read(65536)
                            if not chunk:
                                break
                            size += len(chunk)
                            check(size <= 16 * MIB + 1, "fixture validation part bound")
                            check(observed_total + size <= 64 * MIB + 1, "fixture validation aggregate bound")
                            digest.update(chunk)
                            if info.filename.endswith((".xml", ".rels")):
                                check(len(xml_data) + len(chunk) <= MIB, "fixture XML validation bound")
                                xml_data.extend(chunk)
                except zipfile.BadZipFile:
                    crc_error = True
                    break
                check(size == expected["bytes"], "actual uncompressed size")
                check(digest.hexdigest() == expected["sha256"], "source-part hash")
                observed_total += size
                observed_max = max(observed_max, size)
                if xml_data and case["id"] != "17-doctype":
                    check(b"<!DOCTYPE" not in xml_data, "unexpected DTD")
                    ET.fromstring(xml_data)
                    xml_count += 1
        if case["id"] == "20-zip-crc-invalid":
            check(crc_error, "bad CRC fixture must fail actual read")
            passed(case["id"], {"expectedCrcFailureObserved": True})
        else:
            check(not crc_error, "unexpected CRC failure")
            check(observed_total == case["actualInflatedBytes"], "actual total")
            check(observed_max == case["maxActualPartBytes"], "actual max part")
            passed(case["id"], {"actualInflatedBytes": observed_total, "xmlPartsParsed": xml_count})

    texts = [n.text or "" for n in body(cases["01-text-values"]).findall("w:p/w:r/w:t", NS)]
    check(texts == ["0", "false", "", "  kept  spaces  ", "中文 A & B < C", "after empty"], "literal text oracle")
    passed("literal-zero-false-empty-and-whitespace")

    s = ET.fromstring(part(cases["02-style-inheritance"], "word/styles.xml"))
    style = s.find("w:style[@w:styleId='Derived']", NS)
    check(style.find("w:basedOn", NS).get(f"{{{W}}}val") == "Base", "basedOn")
    check(style.find("w:rPr/w:i", NS) is not None, "inherited italic")
    run_nodes = body(cases["02-style-inheritance"]).findall("w:p/w:r", NS)
    check(run_nodes[1].find("w:rPr/w:b", NS).get(f"{{{W}}}val") == "false", "direct bold false")
    passed("style-source-structure-not-rendered-inheritance")

    n = ET.fromstring(part(cases["03-list-restart"], "word/numbering.xml"))
    check(n.find("w:num[@w:numId='2']/w:lvlOverride/w:startOverride", NS).get(f"{{{W}}}val") == "1", "list restart")
    ids = [p.find("w:pPr/w:numPr/w:numId", NS).get(f"{{{W}}}val") for p in body(cases["03-list-restart"]).findall("w:p", NS)]
    check(ids == ["1", "1", "2", "2"], "list sequence")
    passed("numbering-restart-source-structure")

    table = body(cases["04-table-merges"]).find("w:tbl", NS)
    rows = table.findall("w:tr", NS)
    check(len(rows) == 3 and len(table.findall("w:tblGrid/w:gridCol", NS)) == 3, "table dimensions")
    check(rows[0].find("w:tc/w:tcPr/w:gridSpan", NS).get(f"{{{W}}}val") == "2", "horizontal span")
    check(rows[1].find("w:tc/w:tcPr/w:vMerge", NS).get(f"{{{W}}}val") == "restart", "vertical restart")
    check(rows[2].find("w:tc/w:tcPr/w:vMerge", NS) is not None, "vertical continuation")
    passed("table-merge-source-structure")

    story_case = cases["07-header-footer-footnote"]
    for name, marker in [("word/header1.xml", "HEADER public fixture"), ("word/footer1.xml", "FOOTER public fixture"), ("word/footnotes.xml", "FOOTNOTE public fixture")]:
        check(marker in "".join(ET.fromstring(part(story_case, name)).itertext()), "story text")
    check(body(story_case).find("w:p/w:r/w:footnoteReference", NS).get(f"{{{W}}}id") == "1", "note reference")
    passed("header-footer-footnote-relations-and-content")

    caches, present = [], []
    for p in body(cases["08-field-caches"]).findall("w:p", NS):
        in_result = False
        value = []
        has_result = False
        for r in p.findall("w:r", NS):
            f = r.find("w:fldChar", NS)
            if f is not None:
                kind = f.get(f"{{{W}}}fldCharType")
                if kind == "separate":
                    in_result = has_result = True
                elif kind == "end":
                    in_result = False
            elif in_result:
                value.extend(t.text or "" for t in r.findall("w:t", NS))
        caches.append("".join(value) if has_result else None)
        present.append(has_result)
    check(caches == ["0", "false", "", None] and present == [True, True, True, False], "field result distinction")
    passed("field-cache-empty-versus-missing")

    check(b"<!DOCTYPE" in part(cases["17-doctype"], "word/document.xml"), "DTD marker")
    check(b"vbaProject" in part(cases["12-vba-marker-entry"], "word/_rels/document.xml.rels"), "VBA relation marker")
    check(b"NONEXECUTABLE" in part(cases["12-vba-marker-entry"], "word/vbaProject.bin"), "inert VBA marker")
    with zipfile.ZipFile(ROOT / cases["21-duplicate-entry"]["file"]) as z:
        check(z.namelist().count("word/document.xml") == 2, "duplicate entry must remain")
    with zipfile.ZipFile(ROOT / cases["22-path-escape-entry"]["file"]) as z:
        check("../outside.bin" in z.namelist(), "path traversal marker")
    passed("active-and-container-counterexamples-remain-present")

    bad_png = part(cases["06-png-pixels-invalid"], "word/media/red.png")
    at, compressed = 8, bytearray()
    while at < len(bad_png):
        length = struct.unpack_from(">I", bad_png, at)[0]
        kind = bad_png[at + 4: at + 8]
        data = bad_png[at + 8: at + 8 + length]
        crc = struct.unpack_from(">I", bad_png, at + 8 + length)[0]
        check(zlib.crc32(kind + data) == crc, "counterexample CRC must be good")
        if kind == b"IDAT":
            compressed.extend(data)
        at += 12 + length
    check(zlib.decompress(compressed)[0] == 255, "invalid filter preserved")
    passed("invalid-pixel-png-has-valid-container-and-zlib")

    if pixels:
        from PIL import Image

        results = []
        for name, rgb in [("word/media/red.png", (180, 50, 30)), ("word/media/blue.jpg", (30, 90, 160))]:
            image = Image.open(io.BytesIO(part(cases["05-inline-png-jpeg"], name)))
            image.load()
            check(image.size == (8, 8), "image dimensions")
            pixel = image.convert("RGB").getpixel((4, 4))
            check(all(abs(a - b) <= 4 for a, b in zip(pixel, rgb)), "synthetic color")
            results.append({"part": name, "size": [8, 8], "sampleRGB": list(pixel)})
        failed = False
        try:
            bad = Image.open(io.BytesIO(bad_png))
            bad.load()
        except OSError:
            failed = True
        check(failed, "invalid filter must fail Pillow actual decoding")
        passed("bundled-pillow-real-image-decode", {"images": results, "badPngDecodeFailed": failed, "notBrowserDecodeEvidence": True})

    result = {
        "schemaVersion": 1,
        "scope": "Fixture archive/XML/optional image self-verification only, not product or Word rendering.",
        "passed": True,
        "checkCount": len(checks),
        "fixtureCount": len(cases),
        "archiveBytesTotal": sum(c["archiveBytes"] for c in cases.values()),
        "python": sys.version.split()[0],
        "zlib": zlib.ZLIB_VERSION,
        "usedPillow": pixels,
        "networkOrAppsOrAgentsRun": False,
        "checks": checks,
    }
    (ROOT / "verification.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: result[k] for k in ["passed", "checkCount", "fixtureCount", "archiveBytesTotal", "usedPillow"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--pixels", action="store_true", help="Use bundled Pillow to validate only the synthetic image bytes")
    verify(parser.parse_args().pixels)
