"""Independent, structural DOCX location oracle. Python standard library only.

Paths start at the original XML part root and count all element children,
including compatibility wrappers, properties and markers. No Farfold module,
display block id, rendered sequence or writer readback contributes coordinates.
"""
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import posixpath
import xml.etree.ElementTree as ET
from xml.dom import minidom
import zipfile

OUT = Path(__file__).resolve().parent
BASE = OUT.parent.parent
REPO = BASE.parents[2]
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PR = "http://schemas.openxmlformats.org/package/2006/relationships"
SAMPLES = [
    "docx-compatibility/01-unicode-lists.docx",
    "docx-compatibility/02-table-images-stories.docx",
    "docx-compatibility/03-sections.docx",
    "docx-fixtures/07-header-footer-footnote.docx",
    "docx-fixtures/16-alternate-content.docx",
    "docx-feedback/fixtures/repeated-locations.docx",
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def qname(name):
    if name.startswith("{" + W + "}"):
        return "w:" + name.split("}", 1)[1]
    if name.startswith("{" + MC + "}"):
        return "mc:" + name.split("}", 1)[1]
    return name


def resolve(root, path):
    node = root
    for index in path:
        children = [child for child in node if isinstance(child.tag, str)]
        assert isinstance(index, int) and index >= 0
        node = children[index]
    return node


def read_sample(relative):
    path = BASE / relative
    raw = path.read_bytes()
    roots = {}
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        names = archive.namelist()
        assert len(names) == len(set(names))
        assert sum(x.file_size for x in archive.infolist()) < 2 * 1024 * 1024
        relationships = []
        for name in names:
            if not name.endswith(".rels"):
                continue
            source = "" if name == "_rels/.rels" else posixpath.join(
                posixpath.dirname(posixpath.dirname(name)), posixpath.basename(name)[:-5]
            )
            root = ET.fromstring(archive.read(name))
            for relation in root:
                assert relation.tag == "{" + PR + "}Relationship"
                kind = relation.attrib["Type"].rsplit("/", 1)[-1]
                target = relation.attrib["Target"]
                external = relation.attrib.get("TargetMode") == "External"
                if kind in ["officeDocument", "header", "footer", "footnotes", "endnotes"]:
                    assert not external
                    part = posixpath.normpath(posixpath.join(posixpath.dirname(source), target)).lstrip("/")
                    assert part in names and not part.startswith("../")
                    relationships.append({"sourcePart": source, "id": relation.attrib["Id"],
                                          "kind": kind, "targetPart": part})
                    roots[part] = ET.fromstring(archive.read(part))
        main = [r["targetPart"] for r in relationships if r["sourcePart"] == "" and r["kind"] == "officeDocument"]
        assert len(main) == 1
        targets = []

        def walk(node, part, indices, ancestry, branch=None, note=None):
            if node.tag in ["{" + MC + "}Choice", "{" + MC + "}Fallback"]:
                branch = {"kind": qname(node.tag), "elementPath": indices.copy(),
                          "requires": node.attrib.get("Requires")}
            if node.tag in ["{" + W + "}footnote", "{" + W + "}endnote"]:
                note = {"kind": qname(node.tag), "id": node.attrib.get("{" + W + "}id"),
                        "type": node.attrib.get("{" + W + "}type", "normal")}
            if node.tag in ["{" + W + "}p", "{" + W + "}tbl"]:
                text = "".join(n.text or "" for n in node.iter("{" + W + "}t"))
                assert resolve(roots[part], indices) is node
                targets.append({"part": part, "elementPath": indices.copy(),
                                "blockKind": "paragraph" if node.tag.endswith("}p") else "table",
                                "ancestorElements": ancestry, "text": text,
                                "textSha256": digest(text.encode("utf-8")),
                                "compatibilityBranch": branch, "note": note})
            children = [child for child in node if isinstance(child.tag, str)]
            for index, child in enumerate(children):
                walk(child, part, [*indices, index], [*ancestry, qname(node.tag)], branch, note)

        for part in sorted(roots):
            walk(roots[part], part, [], [])
        # A second stdlib XML representation checks element-only indexing,
        # independently of ElementTree traversal and its resolve() helper.
        for part in sorted(roots):
            dom = minidom.parseString(archive.read(part))
            for target in (t for t in targets if t["part"] == part):
                node = dom.documentElement
                for index in target["elementPath"]:
                    node = [child for child in node.childNodes
                            if child.nodeType == child.ELEMENT_NODE][index]
                assert node.namespaceURI == W
                assert node.localName == ("p" if target["blockKind"] == "paragraph" else "tbl")
                text = "".join(child.data for text_node in node.getElementsByTagNameNS(W, "t")
                               for child in text_node.childNodes
                               if child.nodeType in [child.TEXT_NODE, child.CDATA_SECTION_NODE])
                assert text == target["text"]
            dom.unlink()
        keys = [(t["part"], tuple(t["elementPath"])) for t in targets]
        assert len(keys) == len(set(keys))
        parts = [{"part": part, "sha256": digest(archive.read(part)),
                  "root": qname(root.tag)} for part, root in sorted(roots.items())]
    duplicates = defaultdict(list)
    for target in targets:
        if target["blockKind"] == "paragraph" and target["text"]:
            duplicates[target["text"]].append({"part": target["part"], "elementPath": target["elementPath"]})
    return {"file": str(path.relative_to(REPO)), "bytes": len(raw), "sha256": digest(raw),
            "mainPart": main[0], "parts": parts, "relationships": relationships,
            "targets": targets, "repeatedParagraphLocations": [
                {"text": text, "locations": positions}
                for text, positions in duplicates.items() if len(positions) > 1
            ]}


def main():
    files = [read_sample(name) for name in SAMPLES]
    repeat = files[-1]
    actual = repeat["repeatedParagraphLocations"]
    expected = [
        ("word/document.xml", [0, 1]), ("word/document.xml", [0, 3]),
        ("word/document.xml", [0, 5, 2, 0, 1]), ("word/document.xml", [0, 5, 2, 1, 1]),
        ("word/footer1.xml", [0]), ("word/header1.xml", [0]),
    ]
    assert len(actual) == 1 and actual[0]["text"] == "DUPLICATE 0 false cafe"
    assert [(x["part"], x["elementPath"]) for x in actual[0]["locations"]] == expected
    alternate = files[-2]
    branch_targets = {t["text"]: t for t in alternate["targets"]}
    assert branch_targets["SUPPORTED FALLBACK"]["elementPath"] == [0, 0, 1, 0]
    assert branch_targets["UNSUPPORTED CHOICE"]["elementPath"] == [0, 0, 0, 0, 0]
    choices = {"expectedSelectedText": "SUPPORTED FALLBACK", "expectedSelectedSource": {
        "part": "word/document.xml", "elementPath": [0, 0, 1, 0], "blockKind": "paragraph"},
        "mustNotBeRenderedText": "UNSUPPORTED CHOICE",
        "basis": "Existing synthetic fixture declares unknown fx in Choice Requires, so its literal Fallback branch is expected; coordinates retain both wrappers."}
    note_sample = files[-3]
    assert any(t["note"] and t["note"]["id"] == "1" and t["elementPath"] == [2, 0]
               for t in note_sample["targets"])
    record = {"schemaVersion": 1, "method": "stdlib zipfile CRC + ElementTree; independently resolved again with minidom; no Farfold imports, parser calls or writer readback",
              "pathDefinition": "Zero-based index among original XML element children, starting at the part root; all properties, markers and MC wrappers count. Comments and text nodes do not.",
              "scope": "Structural target oracle; not a claim that every listed paragraph is rendered or offers feedback. Footnote separators and unselected MC branches are explicitly retained for negative checks.",
              "fixtures": files, "alternateContentExpectation": choices,
              "checks": {"files": len(files), "coordinateRoundtrips": sum(len(f["targets"]) for f in files),
                         "duplicateTextDistinctCoordinates": 6, "zipCrc": "all entries passed"}}
    text = json.dumps(record, ensure_ascii=False, indent=2) + "\n"
    (OUT / "oracle.json").write_text(text)
    print(json.dumps(record["checks"]))


if __name__ == "__main__":
    main()
