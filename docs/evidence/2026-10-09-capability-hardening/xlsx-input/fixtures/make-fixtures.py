#!/usr/bin/env python3
# This generator authors its own OOXML. It does not import a Farfold parser,
# generate an oracle from parsed output, or calculate formulas.
import hashlib
import io
import json
import pathlib
import struct
import sys
import zipfile
import zlib
from xml.sax.saxutils import escape, quoteattr

HERE = pathlib.Path(__file__).resolve().parent
MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
STAMP = (2026, 10, 13, 0, 0, 0)


def xml(body):
    return (DECL + body + "\n").encode("utf-8")


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as handle:
        handle.write(data)


def shared(index):
    return '<c r="A1" t="s"><v>%s</v></c>' % index


def synthetic_png():
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xffffffff)
    header = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    scanline = b"\x00\x22\x33\x44"
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(scanline, 9)) + chunk(b"IEND", b"")


def inline(address, text, style=None):
    style_attr = "" if style is None else ' s="%s"' % style
    return '<c r="%s"%s t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>' % (
        address, style_attr, escape(text)
    )


def worksheet(rows, before="", after=""):
    return xml('<worksheet xmlns="%s" xmlns:r="%s">%s<sheetData>%s</sheetData>%s</worksheet>' % (
        MAIN, REL, before, rows, after
    ))


def styles(kind):
    if kind == "date":
        formats = ""
        xfs = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        count = 2
        dxfs = ""
    elif kind == "protection":
        formats = '<numFmts count="1"><numFmt numFmtId="164" formatCode=";;;"/></numFmts>'
        xfs = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="1" hidden="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        count = 3
        dxfs = ""
    elif kind == "gaps":
        formats = '<numFmts count="1"><numFmt numFmtId="165" formatCode=";;;;"/></numFmts>'
        xfs = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        count = 2
        dxfs = '<dxfs count="1"><dxf><numFmt numFmtId="164" formatCode=";;;"/></dxf></dxfs>'
    else:
        formats = ""
        xfs = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        count = 1
        dxfs = ""
    return xml('<styleSheet xmlns="%s">%s<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="%s">%s</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>%s</styleSheet>' % (
        MAIN, formats, count, xfs, dxfs
    ))


def package(sheets, style_kind="plain", sst=None, date1904=False, names="", extras=None):
    extras = extras or {}
    sheet_refs = []
    relationships = []
    parts = {}
    overrides = [
        ('/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'),
        ('/xl/styles.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'),
    ]
    for index, (name, state, data) in enumerate(sheets, 1):
        rid = "rId%s" % index
        sheet_refs.append('<sheet name=%s sheetId="%s" state="%s" r:id="%s"/>' % (
            quoteattr(name), index, state, rid
        ))
        path = "xl/worksheets/sheet%s.xml" % index
        parts[path] = data
        relationships.append('<Relationship Id="%s" Type="%s/worksheet" Target="worksheets/sheet%s.xml"/>' % (
            rid, REL, index
        ))
        overrides.append(('/' + path, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'))
    relationships.append('<Relationship Id="rIdStyles" Type="%s/styles" Target="styles.xml"/>' % REL)
    if sst is not None:
        parts["xl/sharedStrings.xml"] = xml(sst)
        relationships.append('<Relationship Id="rIdSST" Type="%s/sharedStrings" Target="sharedStrings.xml"/>' % REL)
        overrides.append(('/xl/sharedStrings.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'))
    external_ref = ""
    if "xl/externalLinks/externalLink1.xml" in extras:
        external_ref = '<externalReferences><externalReference r:id="rIdExternal"/></externalReferences>'
        relationships.append('<Relationship Id="rIdExternal" Type="%s/externalLink" Target="externalLinks/externalLink1.xml"/>' % REL)
        overrides.append(('/xl/externalLinks/externalLink1.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml'))
    if "xl/drawings/drawing1.xml" in extras:
        overrides.append(('/xl/drawings/drawing1.xml', 'application/vnd.openxmlformats-officedocument.drawing+xml'))
    parts["xl/workbook.xml"] = xml('<workbook xmlns="%s" xmlns:r="%s"><workbookPr date1904="%s"/><sheets>%s</sheets>%s%s<calcPr calcId="0" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>' % (
        MAIN, REL, "1" if date1904 else "0", "".join(sheet_refs), names, external_ref
    ))
    parts["xl/_rels/workbook.xml.rels"] = xml('<Relationships xmlns="%s">%s</Relationships>' % (
        PKG, "".join(relationships)
    ))
    parts["_rels/.rels"] = xml('<Relationships xmlns="%s"><Relationship Id="rIdOffice" Type="%s/officeDocument" Target="xl/workbook.xml"/></Relationships>' % (
        PKG, REL
    ))
    parts["xl/styles.xml"] = styles(style_kind)
    override_xml = "".join('<Override PartName=%s ContentType=%s/>' % (quoteattr(a), quoteattr(b)) for a, b in overrides)
    parts["[Content_Types].xml"] = xml('<Types xmlns="%s"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>%s</Types>' % (
        CT, override_xml
    ))
    parts.update(extras)
    return parts


def definitions():
    rows = (
        '<row r="1">'
        '<c r="A1" t="s"><v>0</v></c>'
        '<c r="B1" t="n"><v>0</v></c>'
        + inline("C1", "HIDDEN_COLUMN")
        + '<c r="D1" t="b"><v>0</v></c>'
        '<c r="E1" t="str"><v/></c>'
        '<c r="F1"/>'
        '<c r="G1" t="n"><v>9007199254740993</v></c>'
        '<c r="H1" t="e"><v>#DIV/0!</v></c>'
        + inline("I1", "[1]")
        + '<c r="J1" t="inlineStr"><is><r><t xml:space="preserve"> prefix </t></r><r><rPr><b/></rPr><t>&amp; suffix </t></r></is></c>'
        '<c r="K1" s="1" t="n"><v>0</v></c>'
        '<c r="L1" t="d"><v>2026-10-13T00:00:00Z</v></c>'
        '</row><row r="2" hidden="1">' + inline("A2", "HIDDEN_ROW") + '</row>'
        '<row r="3"><c r="A3" t="inlineStr"><is><r><t xml:space="preserve">Inline </t></r><r><rPr><b/></rPr><t>rich</t></r></is></c></row>'
        '<row r="4"><c r="A4" t="n"><f>1-1</f><v>0</v></c>'
        '<c r="B4" t="n"><f>1+2</f></c>'
        '<c r="C4" t="str"><f>""</f><v/></c></row>'
        '<row r="5"><c r="A5" t="n"><f t="shared" ref="A5:A6" si="0">B1+1</f><v>1</v></c></row>'
        '<row r="6"><c r="A6" t="n"><f t="shared" si="0"/><v>2</v></c></row>'
        '<row r="8">' + inline("A8", "MERGE_ANCHOR") + '</row>'
    )
    data = worksheet(rows, before='<cols><col min="3" max="3" hidden="1" width="12" customWidth="1"/></cols>', after='<mergeCells count="1"><mergeCell ref="A8:B8"/></mergeCells>')
    tail = worksheet('<row r="1"><c r="A1" t="s"><v>1</v></c></row><row r="101">' + inline("Y101", "END_TAIL") + '</row><row r="1048576">' + inline("XFD1048576", "FAR_CORNER") + '</row>')
    hidden = worksheet('<row r="1">' + inline("A1", "HIDDEN_SHEET") + '</row>')
    very_hidden = worksheet('<row r="1">' + inline("A1", "VERY_HIDDEN_SHEET") + '</row>')
    sst = '<sst xmlns="%s" count="2" uniqueCount="2"><si><t>Shared \u96f6</t></si><si><r><t xml:space="preserve">Shared </t></r><r><rPr><i/></rPr><t>rich</t></r></si></sst>' % MAIN
    values = package([("Data", "visible", data), ("Tail", "visible", tail), ("Hidden", "hidden", hidden), ("VeryHidden", "veryHidden", very_hidden)], "date", sst, True)

    protected = worksheet(
        '<row r="1"><c r="A1" s="1" t="n"><f>3+4</f><v>7</v></c><c r="B1" s="2" t="n"><v>123.45</v></c>'
        + inline("C1", "HIDDEN_BY_FORMAT", 2) + inline("D1", "VISIBLE_GRID_SECRET", 1)
        + '</row><row r="2"><c r="A2" s="1" t="n"><f>6+1</f></c><c r="B2" t="n"><v>0</v></c></row>',
        after='<sheetProtection sheet="1" objects="1" scenarios="1"/>'
    )
    unprotected = worksheet('<row r="1"><c r="A1" s="1" t="n"><f>3+4</f><v>7</v></c></row>')
    protection = package([("Protected", "visible", protected), ("Unprotected", "visible", unprotected)], "protection")

    gap_sheet = worksheet(
        '<row r="1">' + inline("A1", "LOCAL_CELL_WORDS") + '</row><row r="2"><c r="A2" s="1" t="n"><v>10</v></c></row>'
        '<row r="3"><c r="A3" t="n"><f>[1]Remote!A1+1</f><v>99</v></c></row>'
        '<row r="6">' + inline("A6", "VISIBLE_MERGE_ANCHOR") + inline("B6", "COVERED_SAVED_VALUE") + '</row>',
        after='<mergeCells count="1"><mergeCell ref="A6:B6"/></mergeCells><conditionalFormatting sqref="A2"><cfRule type="expression" dxfId="0" priority="1"><formula>TRUE</formula></cfRule></conditionalFormatting><drawing r:id="rIdDrawing"/>'
    )
    drawing = xml('<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="%s"><xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="914400" cy="914400"/><xdr:sp><xdr:nvSpPr><xdr:cNvPr id="2" name="Fixture shape"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr><xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>DRAWING_ONLY_WORDS</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:oneCellAnchor><xdr:oneCellAnchor><xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="914400" cy="914400"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Fixture pixel" descr="SYNTHETIC_PIXEL"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>' % REL)
    pixel = synthetic_png()
    extras = {
        "xl/worksheets/_rels/sheet1.xml.rels": xml('<Relationships xmlns="%s"><Relationship Id="rIdDrawing" Type="%s/drawing" Target="../drawings/drawing1.xml"/></Relationships>' % (PKG, REL)),
        "xl/drawings/drawing1.xml": drawing,
        "xl/drawings/_rels/drawing1.xml.rels": xml('<Relationships xmlns="%s"><Relationship Id="rIdImage" Type="%s/image" Target="../media/fixture.png"/></Relationships>' % (PKG, REL)),
        "xl/media/fixture.png": pixel,
        "xl/externalLinks/externalLink1.xml": xml('<externalLink xmlns="%s" xmlns:r="%s"><externalBook r:id="rIdRemote"><sheetNames><sheetName val="Remote"/></sheetNames><sheetDataSet><sheetData sheetId="0"><row r="1"><cell r="A1" t="str"><v>REMOTE_CACHED_ONLY</v></cell></row></sheetData></sheetDataSet></externalBook></externalLink>' % (MAIN, REL)),
        "xl/externalLinks/_rels/externalLink1.xml.rels": xml('<Relationships xmlns="%s"><Relationship Id="rIdRemote" Type="%s/externalLinkPath" Target="https://example.invalid/farfold-fixture.xlsx" TargetMode="External"/></Relationships>' % (PKG, REL)),
    }
    names = '<definedNames><definedName name="VisibleName" localSheetId="0">Gap!$A$1</definedName><definedName name="HiddenName" hidden="1">Gap!$A$2</definedName></definedNames>'
    gaps = package([("Gap", "visible", gap_sheet)], "gaps", names=names, extras=extras)

    first = worksheet('<row r="1">' + inline("A1", "FIRST_SHEET_OK") + '</row>')
    bad = worksheet('<row r="1"><c r="A1" t="s"><v>999</v></c></row>')
    one_sst = '<sst xmlns="%s" count="1" uniqueCount="1"><si><t>ONLY_STRING</t></si></sst>' % MAIN
    invalid_late = package([("First", "visible", first), ("Broken", "visible", bad)], sst=one_sst)

    budget_sheets = []
    for name in ("BudgetA", "BudgetB"):
        cells = []
        for row in range(1, 6):
            payload = "BUDGET_%s_A%s:" % (name, row) + "\u6570" * 9000 + ":END_%s_A%s" % (name, row)
            cells.append('<row r="%s">%s</row>' % (row, inline("A%s" % row, payload)))
        budget_sheets.append((name, "visible", worksheet("".join(cells))))
    budget = package(budget_sheets)
    return {
        "01-values-scope": values,
        "02-protection-format": protection,
        "03-unread-surfaces": gaps,
        "04-invalid-late-sheet": invalid_late,
        "05-text-budget": budget,
    }


def archive(parts):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as handle:
        for name in sorted(parts):
            info = zipfile.ZipInfo(name, STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            handle.writestr(info, parts[name], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return buffer.getvalue()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    destination = HERE / "generated-v2" if len(sys.argv) == 1 else pathlib.Path(sys.argv[1]).resolve()
    if destination.exists():
        raise SystemExit("Refusing existing destination; generate only into a fresh directory.")
    destination.mkdir(parents=True)
    inventory = []
    for name, parts in definitions().items():
        payload = archive(parts)
        save(destination / (name + ".xlsx"), payload)
        part_inventory = []
        for part, data in sorted(parts.items()):
            save(destination / "raw" / name / part, data)
            part_inventory.append({"path": part, "bytes": len(data), "sha256": sha(data)})
        inventory.append({
            "id": name, "file": name + ".xlsx", "bytes": len(payload), "sha256": sha(payload),
            "entryCount": len(parts), "expandedBytes": sum(len(data) for data in parts.values()),
            "parts": part_inventory,
        })
    save(destination / "inventory.json", (json.dumps({
        "schema": 1,
        "author": "Synthetic fixtures; no original user files or production parser.",
        "zipTimestamp": list(STAMP),
        "fixtures": inventory,
        "formulaExecution": False,
        "externalFetch": False,
        "officeSchemaOrExcelAcceptance": "UNTESTED",
    }, indent=2, ensure_ascii=True) + "\n").encode("utf-8"))
    print(json.dumps({"destination": str(destination), "fixtures": len(inventory)}))


if __name__ == "__main__":
    main()
