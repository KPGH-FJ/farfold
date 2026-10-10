"""Read only self-authored fixture ZIP/XML; no Farfold or writer import."""

from hashlib import sha256
from pathlib import PurePosixPath
import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile

S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
P = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def location(address):
    match = re.fullmatch(r"([A-Z]+)([1-9][0-9]*)", address)
    assert match, address
    column = 0
    for letter in match[1]:
        column = column * 26 + ord(letter) - ord("A") + 1
    return {"row":int(match[2]),"column":column}


def bounds(address):
    first, last = address.split(":") if ":" in address else (address, address)
    a, b = location(first), location(last)
    return {"fromRow":a["row"],"toRow":b["row"],"fromColumn":a["column"],"toColumn":b["column"]}


def inspect_workbook(path):
    data = path.read_bytes()
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        entries = archive.namelist()
        assert len(entries) == len(set(entries))
        assert sum(i.file_size for i in archive.infolist()) < 1024 * 1024
        # These generated packages use the ordinary root officeDocument target.
        root_relations = ET.fromstring(archive.read("_rels/.rels"))
        documents = [n for n in root_relations if n.attrib["Type"].endswith("/officeDocument")]
        assert len(documents) == 1 and documents[0].attrib.get("TargetMode") != "External"
        workbook_part = documents[0].attrib["Target"].lstrip("/")
        directory, filename = posixpath.split(workbook_part)
        rels_part = posixpath.join(directory,"_rels",filename+".rels")
        relation_nodes = ET.fromstring(archive.read(rels_part))
        relations = {n.attrib["Id"]:dict(n.attrib) for n in relation_nodes}
        assert len(relations) == len(relation_nodes)
        workbook = ET.fromstring(archive.read(workbook_part))
        sheets = []
        for index, sheet in enumerate(workbook.find(S+"sheets")):
            rid = sheet.attrib[R+"id"]
            relation = relations[rid]
            assert relation["Type"].endswith("/worksheet") and relation.get("TargetMode") != "External"
            raw = relation["Target"]
            part = raw.lstrip("/") if raw.startswith("/") else posixpath.normpath(posixpath.join(directory,raw))
            assert ".." not in PurePosixPath(part).parts and part in entries
            root = ET.fromstring(archive.read(part))
            cells = {}
            rows = {}
            for row in root.find(S+"sheetData"):
                row_number = row.attrib["r"]
                rows[row_number] = {"hidden":row.attrib.get("hidden","0") in ("1","true"),"height":row.attrib.get("ht")}
                for cell in row:
                    address = cell.attrib["r"]
                    value = cell.find(S+"v")
                    formula = cell.find(S+"f")
                    inline = cell.find(S+"is")
                    cells[address] = {
                        **location(address),
                        "type":cell.attrib.get("t","n"),
                        "styleId":int(cell.attrib.get("s","0")),
                        "valueElementPresent":value is not None,
                        "rawValue":value.text if value is not None else None,
                        "inlineStringElementPresent":inline is not None,
                        "inlineText":"".join(inline.itertext()) if inline is not None else None,
                        "formulaElementPresent":formula is not None,
                        "formula":formula.text if formula is not None else None,
                        "formulaCacheHasText":formula is not None and value is not None and value.text is not None,
                    }
            columns = root.find(S+"cols")
            merges = root.find(S+"mergeCells")
            sheets.append({
                "sheetOrderZeroBased":index,"relationshipId":rid,"sheetIdAttribute":sheet.attrib["sheetId"],"name":sheet.attrib["name"],"state":sheet.attrib.get("state","visible"),"part":part,
                "partSha256":sha256(archive.read(part)).hexdigest(),
                "dimension":root.find(S+"dimension").attrib["ref"],
                "cells":cells,"rows":rows,
                "columns":[] if columns is None else [{"min":int(n.attrib["min"]),"max":int(n.attrib["max"]),"hidden":n.attrib.get("hidden","0") in ("1","true"),"width":n.attrib.get("width")} for n in columns],
                "merges":{} if merges is None else {n.attrib["ref"]:bounds(n.attrib["ref"]) for n in merges},
            })
        return {"fileSha256":sha256(data).hexdigest(),"fileBytes":len(data),"crcAllEntriesValid":True,"workbookPart":workbook_part,"sheetRelationshipsPart":rels_part,"entryCount":len(entries),"sheets":sheets}
