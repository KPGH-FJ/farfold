"""Check authored expectations using Python's ZIP/XML libraries, not Farfold.

This verifies package facts and authored text. The separate LibreOffice render
is the visual reference; this script does not claim Word layout equivalence.
"""

import hashlib
import json
from pathlib import Path
import posixpath
import xml.etree.ElementTree as ET
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"


def text(element):
    return "".join(node.text or "" for node in element.iter(W + "t"))


def check(sample):
    path = ROOT / sample["file"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == sample["sha256"]
    with ZipFile(path) as package:
        assert package.testzip() is None
        names = package.namelist()
        assert len(names) == len(set(names))
        assert not any(name.startswith("/") or ".." in name.split("/") for name in names)
        assert not any("vba" in name.lower() or "activex" in name.lower() for name in names)
        xml = {
            name: ET.fromstring(package.read(name))
            for name in names
            if name.endswith((".xml", ".rels"))
        }
        external = [
            item.attrib
            for name, root in xml.items()
            if name.endswith(".rels")
            for item in root
            if item.get("TargetMode") == "External"
        ]
        assert not external
        main = xml["word/document.xml"]
        body = main.find(W + "body")
        assert body is not None
        paragraphs = [text(item) for item in body if item.tag == W + "p"]
        wanted = sample.get("requiredBodyTextInOrder")
        if wanted:
            assert [value for value in paragraphs if value] == wanted
        all_text = [text(item) for item in body.iter(W + "p")]
        for value in sample.get("requiredText", []):
            assert value in all_text, value
        result = {
            "file": sample["file"],
            "sha256": sample["sha256"],
            "zipEntries": len(names),
            "crc": "all entries passed",
            "externalRelationships": external,
            "bodyText": "matches authored expectations",
            "bodyParagraphs": len(paragraphs),
        }
        rels = {
            item.get("Id"): posixpath.normpath("word/" + item.get("Target", ""))
            for item in xml["word/_rels/document.xml.rels"]
        }
        sections = list(main.iter(W + "sectPr"))
        stories = {"headers": [], "footers": []}
        for section in sections:
            for kind in ("header", "footer"):
                for ref in section.findall(W + kind + "Reference"):
                    target = rels[ref.get(R + "id")]
                    assert target in xml
                    stories[kind + "s"].append(text(xml[target]))
        for kind in ("header", "footer"):
            expected = sample.get(kind + "s") or ([sample[kind]] if kind in sample else None)
            if expected:
                assert stories[kind + "s"] == expected
        if "sections" in sample:
            assert len(sections) == sample["sections"]
        result["sections"] = len(sections)
        result["stories"] = stories
        if "numberedItems" in sample:
            styles = {
                item.get(W + "styleId"): item
                for item in xml["word/styles.xml"].findall(W + "style")
            }
            numbering = xml["word/numbering.xml"]
            checks = []
            for label, key, expected_format in (
                ("numbered", "numberedItems", "decimal"),
                ("bullet", "bulletItems", "bullet"),
            ):
                group = []
                for para in body.findall(W + "p"):
                    if text(para) not in sample[key]:
                        continue
                    style_id = para.find(W + "pPr/" + W + "pStyle").get(W + "val")
                    num_id = styles[style_id].find(W + "pPr/" + W + "numPr/" + W + "numId").get(W + "val")
                    num = next(item for item in numbering.findall(W + "num") if item.get(W + "numId") == num_id)
                    abstract_id = num.find(W + "abstractNumId").get(W + "val")
                    abstract = next(item for item in numbering.findall(W + "abstractNum") if item.get(W + "abstractNumId") == abstract_id)
                    level = abstract.find(W + "lvl")
                    assert level.find(W + "numFmt").get(W + "val") == expected_format
                    assert level.find(W + "start").get(W + "val") == "1"
                    if label == "numbered":
                        assert level.find(W + "lvlText").get(W + "val") == "%1."
                    group.append({"text": text(para), "style": style_id, "numId": num_id})
                assert [item["text"] for item in group] == sample[key]
                assert len({item["numId"] for item in group}) == 1
                checks.append({"kind": label, "format": expected_format, "items": group})
            result["lists"] = checks
            empty = [para for para in body.findall(W + "p") if not text(para)]
            assert len(empty) == sample["emptyParagraphs"]
            for expected_text, formatting in sample["directRunFormatting"].items():
                run = next(run for run in body.iter(W + "r") if text(run) == expected_text)
                assert run.find(W + "rPr/" + W + {"bold": "b", "italic": "i"}[formatting]) is not None
        if "tables" in sample:
            table = body.find(W + "tbl")
            rows = table.findall(W + "tr")
            assert len(rows) == 4
            assert len(table.find(W + "tblGrid")) == 3
            cells = [row.findall(W + "tc") for row in rows]
            assert cells[0][0].find(W + "tcPr/" + W + "gridSpan").get(W + "val") == "2"
            assert cells[1][0].find(W + "tcPr/" + W + "vMerge").get(W + "val") == "restart"
            assert cells[2][0].find(W + "tcPr/" + W + "vMerge") is not None
            assert not text(cells[2][1])
            result["table"] = "4 rows, 3-column grid, horizontal/vertical merges, empty cell verified"
        if "images" in sample:
            image_parts = [rels[item.get(R + "embed")] for item in body.iter(A + "blip")]
            assert len(image_parts) == len(sample["images"])
            result["images"] = []
            for part, expected in zip(image_parts, sample["images"], strict=True):
                content = package.read(part)
                assert content == (ROOT / expected["asset"]).read_bytes()
                result["images"].append({"part": part, "sha256": hashlib.sha256(content).hexdigest(), "authoredAsset": expected["asset"]})
        return result


if __name__ == "__main__":
    expected = json.loads((ROOT / "expectations.json").read_text())
    result = {"method": "stdlib zipfile + ElementTree; no Farfold or python-docx readback", "samples": [check(item) for item in expected["samples"]]}
    print(json.dumps(result, ensure_ascii=False, indent=2))
