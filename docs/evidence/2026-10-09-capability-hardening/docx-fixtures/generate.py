#!/usr/bin/env python3
"""Deterministic, public synthetic OOXML fixtures. No app, network or Agent.

Only writes below this script's directory. Uses Python's standard library.
Deliberate corrupt/unsupported cases are not reference Word documents.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import pathlib
import struct
import warnings
import zipfile
import zlib
from xml.sax.saxutils import escape

ROOT = pathlib.Path(__file__).resolve().parent
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
MIB = 1024 * 1024
DATE = (1980, 1, 1, 0, 0, 0)
JPEG = base64.b64decode(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooor94Px8//2Q=='
)


def png(corrupt_pixels=False):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    pixels = b"".join(b"\x00" + bytes([180, 50, 30]) * 8 for _ in range(8))
    # A valid PNG container/CRC and zlib stream, but invalid PNG filter 255.
    if corrupt_pixels:
        pixels = bytes([255]) + pixels[1:]
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(pixels, 9))
        + chunk(b"IEND", b"")
    )


def xml(value):
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + value).encode()


def run(text, props="", preserve=False):
    return (
        "<w:r>"
        + ("<w:rPr>" + props + "</w:rPr>" if props else "")
        + ('<w:t xml:space="preserve">' if preserve else "<w:t>")
        + escape(text)
        + "</w:t></w:r>"
    )


def para(text=None, props="", runs=None):
    return (
        "<w:p>"
        + ("<w:pPr>" + props + "</w:pPr>" if props else "")
        + (run(text) if runs is None and text is not None else (runs or ""))
        + "</w:p>"
    )


def document(body, sect=""):
    return xml(
        f'<w:document xmlns:w="{W}" xmlns:r="{R}" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '
        'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
        'xmlns:fx="urn:farfold:public-docx-fixture">'
        "<w:body>"
        + body
        + '<w:sectPr>'
        + sect
        + '<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>'
        + "</w:sectPr></w:body></w:document>"
    )


def rels(rows):
    out = []
    for rid, kind, target, external in rows:
        mode = ' TargetMode="External"' if external else ""
        out.append(f'<Relationship Id="{rid}" Type="{kind}" Target="{escape(target, {chr(34): "&quot;"})}"{mode}/>')
    return xml(f'<Relationships xmlns="{PKG}">' + "".join(out) + "</Relationships>")


def package(body, extra=None, relationships=None, overrides=None, main_type=MAIN, sect=""):
    overrides = {"word/document.xml": main_type, **(overrides or {})}
    content = (
        f'<Types xmlns="{CT}">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="png" ContentType="image/png"/>'
        '<Default Extension="jpg" ContentType="image/jpeg"/>'
        '<Default Extension="bin" ContentType="application/octet-stream"/>'
        '<Default Extension="html" ContentType="text/html"/>'
        + "".join(f'<Override PartName="/{name}" ContentType="{mime}"/>' for name, mime in sorted(overrides.items()))
        + "</Types>"
    )
    result = {
        "[Content_Types].xml": xml(content),
        "_rels/.rels": rels([("rIdDocument", R + "/officeDocument", "word/document.xml", False)]),
        "word/document.xml": document(body, sect),
        **(extra or {}),
    }
    if relationships:
        result["word/_rels/document.xml.rels"] = rels(relationships)
    return result


def archive(entries):
    data = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(data, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for name, value in entries:
                entry = zipfile.ZipInfo(name, DATE)
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(entry, value, compresslevel=9)
    return data.getvalue()


def drawing(rid, number=1):
    return (
        '<w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/>'
        f'<wp:docPr id="{number}" name="Synthetic image {number}" descr="Public synthetic 8 by 8 image"/>'
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="fixture"/><pic:cNvPicPr/></pic:nvPicPr>'
        f'<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
        '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
    )


def field(instruction, cached):
    middle = "" if cached is None else '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' + run(cached, preserve=True)
    return (
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        '<w:r><w:instrText xml:space="preserve">' + escape(instruction) + "</w:instrText></w:r>"
        + middle + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
    )


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    cases = []

    def emit(identifier, title, entries, expected, mutate=None):
        pairs = list(entries.items()) if isinstance(entries, dict) else entries
        raw = archive(pairs)
        if mutate:
            raw = mutate(raw)
        filename = identifier + ".docx"
        (ROOT / filename).write_bytes(raw)
        cases.append({
            "id": identifier, "title": title, "file": filename,
            "sha256": hashlib.sha256(raw).hexdigest(), "archiveBytes": len(raw),
            "entryCount": len(pairs), "actualInflatedBytes": sum(len(v) for _, v in pairs),
            "maxActualPartBytes": max(len(v) for _, v in pairs),
            "sourceParts": [{"name": n, "bytes": len(v), "sha256": hashlib.sha256(v).hexdigest()} for n, v in pairs],
            "expected": expected,
        })

    def shown(values, **more):
        return {"profileOutcome": "supported", "visibleTextInOrder": values, **more}

    def rejected(reason, **more):
        return {"profileOutcome": "reject", "reason": reason, "mustNotReportComplete": True, **more}

    values = ["0", "false", "", "  kept  spaces  ", "中文 A & B < C", "after empty"]
    emit("01-text-values", "文字零 假 空和空格", package("".join(para(runs=run(t, preserve=True)) for t in values)),
         shown(values, literalFalseIsNotBoolean=True, emptyParagraphIndex=2))

    styles = xml(f'<w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>'
                 '<w:style w:type="paragraph" w:styleId="Base"><w:name w:val="Base"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:color w:val="123456"/></w:rPr></w:style>'
                 '<w:style w:type="paragraph" w:styleId="Derived"><w:name w:val="Derived"/><w:basedOn w:val="Base"/><w:rPr><w:i/></w:rPr></w:style></w:styles>')
    body = para(props='<w:pStyle w:val="Derived"/>', runs=run("inherits bold italic color", preserve=True) + run(" direct bold off", '<w:b w:val="false"/>', True))
    emit("02-style-inheritance", "段落样式继承和直接关闭", package(body, {"word/styles.xml": styles}, [("rIdStyles", R + "/styles", "styles.xml", False)], {"word/styles.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"}),
         shown(["inherits bold italic color", " direct bold off"], expectedRuns=[{"bold": True, "italic": True, "color": "123456", "halfPointSize": 22}, {"bold": False, "italic": True, "color": "123456", "halfPointSize": 22}], paragraphAlignment="center"))

    numbering = xml(f'<w:numbering xmlns:w="{W}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>'
                    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num></w:numbering>')
    nums = [(1, "first"), (1, "second"), (2, "restart first"), (2, "restart second")]
    body = "".join(para(t, f'<w:numPr><w:ilvl w:val="0"/><w:numId w:val="{n}"/></w:numPr>') for n, t in nums)
    emit("03-list-restart", "同一抽象编号的显式重启", package(body, {"word/numbering.xml": numbering}, [("rIdNumbering", R + "/numbering", "numbering.xml", False)], {"word/numbering.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"}),
         shown([t for _, t in nums], listLabels=["1.", "2.", "1.", "2."]))

    def cell(text, props=""):
        return '<w:tc><w:tcPr>' + props + '</w:tcPr>' + para(text) + '</w:tc>'

    table = ('<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>'
             '<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>'
             '<w:tr>' + cell("H merged", '<w:gridSpan w:val="2"/>') + cell("C") + '</w:tr>'
             '<w:tr>' + cell("V merged", '<w:vMerge w:val="restart"/>') + cell("0") + cell("false") + '</w:tr>'
             '<w:tr>' + cell("", '<w:vMerge/>') + cell("") + cell("tail") + '</w:tr></w:tbl>')
    emit("04-table-merges", "普通表格横向和纵向合并", package(table), shown(["H merged", "C", "V merged", "0", "false", "", "tail"], table={"rows": 3, "gridColumns": 3, "merges": [{"row": 0, "column": 0, "rowSpan": 1, "columnSpan": 2}, {"row": 1, "column": 0, "rowSpan": 2, "columnSpan": 1}], "emptyCell": [2, 1]}))

    image_rels = [("rIdPng", R + "/image", "media/red.png", False), ("rIdJpeg", R + "/image", "media/blue.jpg", False)]
    images = {"word/media/red.png": png(), "word/media/blue.jpg": JPEG}
    emit("05-inline-png-jpeg", "两个包内静态图片", package(para("PNG") + para(runs=drawing("rIdPng")) + para("JPEG") + para(runs=drawing("rIdJpeg", 2)), images, image_rels),
         shown(["PNG", "JPEG"], images=[{"part": "word/media/red.png", "mimeType": "image/png", "width": 8, "height": 8, "expectedRGB": [180, 50, 30]}, {"part": "word/media/blue.jpg", "mimeType": "image/jpeg", "width": 8, "height": 8, "expectedRGBNear": [30, 90, 160], "channelTolerance": 4}], drawingExtentsEMU=[914400, 914400]))
    emit("06-png-pixels-invalid", "PNG容器正常但像素滤波损坏", package(para("before image") + para(runs=drawing("rIdPng")) + para("after image"), {"word/media/red.png": png(True)}, image_rels[:1]),
         {"profileOutcome": "reject-or-explicit-partial", "reason": "image-decode-failure", "visibleTextIfPartial": ["before image", "after image"], "mustNotReportComplete": True, "pngChunkCRCValid": True, "zlibStreamValid": True, "invalidFirstFilter": 255})

    header = xml(f'<w:hdr xmlns:w="{W}" xmlns:r="{R}">' + para("HEADER public fixture") + '</w:hdr>')
    footer = xml(f'<w:ftr xmlns:w="{W}" xmlns:r="{R}">' + para("FOOTER public fixture") + '</w:ftr>')
    footnote = xml(f'<w:footnotes xmlns:w="{W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1">' + para("FOOTNOTE public fixture") + '</w:footnote></w:footnotes>')
    stories = {"word/header1.xml": header, "word/footer1.xml": footer, "word/footnotes.xml": footnote}
    story_rels = [("rIdHeader", R + "/header", "header1.xml", False), ("rIdFooter", R + "/footer", "footer1.xml", False), ("rIdFootnotes", R + "/footnotes", "footnotes.xml", False)]
    types = {"word/header1.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml", "word/footer1.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml", "word/footnotes.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"}
    emit("07-header-footer-footnote", "正文与独立故事区域", package(para(runs=run("BODY with footnote") + '<w:r><w:footnoteReference w:id="1"/></w:r>'), stories, story_rels, types, sect='<w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/>'),
         shown(["BODY with footnote"], stories={"header": "HEADER public fixture", "footer": "FOOTER public fixture", "footnote:1": "FOOTNOTE public fixture"}, mustNotTreatStoryAsWordPage=True))

    fields = [field(" PAGE ", "0"), field(" MERGEFIELD flag ", "false"), field(" MERGEFIELD empty ", ""), field(" INCLUDETEXT https://docx-fixture.invalid/never-fetch ", None)]
    emit("08-field-caches", "字段缓存零 假 空与缺失", package("".join(para(runs=f) for f in fields)),
         {"profileOutcome": "supported-with-notice", "fieldCachedResults": ["0", "false", "", None], "fieldCachePresent": [True, True, True, False], "mustNotShowInstructionsAsBody": True, "mustNotExecuteOrRefresh": True, "missingResultMustBeExplicit": True})

    externals = [("rIdUrl", R + "/hyperlink", "https://docx-fixture.invalid/never-open", True), ("rIdScript", R + "/hyperlink", "javascript:globalThis.__FARFOLD_DOCX_FIXTURE__=1", True), ("rIdPng", R + "/image", "https://docx-fixture.invalid/never-load.png", True), ("rIdLocal", R + "/image", "file:///FARFOLD_DOCX_FIXTURE_DO_NOT_READ", True)]
    ext_body = para(runs='<w:hyperlink r:id="rIdUrl">' + run("public link label") + '</w:hyperlink>') + para(runs='<w:hyperlink r:id="rIdScript">' + run("script link label") + '</w:hyperlink>') + para(runs=drawing("rIdPng"))
    emit("09-external-relationships", "远程和本地关系保持惰性", package(ext_body, relationships=externals),
         {"profileOutcome": "reject-or-explicit-partial", "visibleTextIfPartial": ["public link label", "script link label"], "mustNotNavigate": True, "networkRequests": 0, "extraFileReads": 0, "mustNotReportComplete": True})

    alt = b'<html><body><p>ALTCHUNK public canary</p><script>globalThis.__FARFOLD_DOCX_FIXTURE__=1</script><img src="https://docx-fixture.invalid/never-load.png"></body></html>'
    emit("10-altchunk-html", "主动HTML内容部件", package(para("before altchunk") + '<w:altChunk r:id="rIdAlt"/>' + para("after altchunk"), {"word/chunk.html": alt}, [("rIdAlt", R + "/aFChunk", "chunk.html", False)]),
         rejected("altChunk-active-content", scriptsExecuted=0, networkRequests=0, note="HTML is a synthetic canary, never rendered during generation."))
    emit("11-macro-content-type", "宏主类型伪装docx后缀", package(para("macro type marker only"), main_type="application/vnd.ms-word.document.macroEnabled.main+xml"),
         rejected("macro-enabled-main-content-type", actualExecutableMacro=False))
    emit("12-vba-marker-entry", "正常主类型中的VBA关系标记", package(para("vba marker only"), {"word/vbaProject.bin": b"FARFOLD SYNTHETIC NONEXECUTABLE VBA MARKER\n"}, [("rIdVba", "http://schemas.microsoft.com/office/2006/relationships/vbaProject", "vbaProject.bin", False)], {"word/vbaProject.bin": "application/vnd.ms-office.vbaProject"}),
         rejected("macro-relationship-or-part", actualExecutableMacro=False, limitation="Tests structural refusal only, not real VBA execution blocking."))

    revision = para(runs=run("kept ") + '<w:del w:id="1" w:author="Public Fixture" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>deleted secret marker</w:delText></w:r></w:del>' + '<w:ins w:id="2" w:author="Public Fixture" w:date="2026-01-01T00:00:00Z">' + run("inserted marker") + '</w:ins>')
    emit("13-revisions", "未接受的删除和插入", package(revision), {"profileOutcome": "reject-or-explicit-partial", "mustNotSilentlyAcceptOrRejectChanges": True, "mustNotReportComplete": True, "deletedTextMustNotAppearAsNormalBody": "deleted secret marker"})
    emit("14-hidden-run", "显式隐藏正文", package(para(runs=run("visible before ") + run("HIDDEN public marker", '<w:vanish/>') + run(" visible after"))),
         {"profileOutcome": "supported-with-notice-or-reject", "visibleTextInOrder": ["visible before ", " visible after"], "mustNotAppearInDefaultBody": ["HIDDEN public marker"], "hiddenContentMustBeAcknowledged": True})
    emit("15-unknown-body-element", "未知正文元素不能被默默忽略", package(para("known before") + '<fx:unsupported>' + para("unknown wrapped body") + '</fx:unsupported>' + para("known after")),
         rejected("unknown-content-without-compatibility-contract", mustNotSucceedByCollectingAllTextNodes=True))
    alternate = '<mc:AlternateContent><mc:Choice Requires="fx"><fx:special>' + para("UNSUPPORTED CHOICE") + '</fx:special></mc:Choice><mc:Fallback>' + para("SUPPORTED FALLBACK") + '</mc:Fallback></mc:AlternateContent>'
    emit("16-alternate-content", "选择后备内容且不重复分支", package(alternate), {"profileOutcome": "supported-if-mc-implemented-otherwise-reject", "visibleTextInOrder": ["SUPPORTED FALLBACK"], "mustNotAppearInBody": ["UNSUPPORTED CHOICE"], "mustNotRenderBothBranches": True})

    dtd = package(para("placeholder"))
    dtd["word/document.xml"] = dtd["word/document.xml"].replace(b'?>', b'?><!DOCTYPE w:document [<!ENTITY fx "DTD public canary">]>', 1).replace(b"placeholder", b"&fx;")
    emit("17-doctype", "禁止DTD和实体", dtd, rejected("doctype", networkRequests=0))
    cycle = xml(f'<w:styles xmlns:w="{W}"><w:style w:type="paragraph" w:styleId="A"><w:basedOn w:val="B"/></w:style><w:style w:type="paragraph" w:styleId="B"><w:basedOn w:val="A"/></w:style></w:styles>')
    emit("18-style-cycle", "样式引用循环", package(para("cycle", '<w:pStyle w:val="A"/>'), {"word/styles.xml": cycle}, [("rIdStyles", R + "/styles", "styles.xml", False)], {"word/styles.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"}), rejected("style-cycle", mustTerminate=True))
    emit("19-missing-image-part", "已引用图片缺失", package(para("before missing") + para(runs=drawing("rIdPng")), relationships=image_rels[:1]),
         {"profileOutcome": "reject-or-explicit-partial", "reason": "missing-image-part", "mustNotReportComplete": True})

    def corrupt_crc(raw):
        b = bytearray(raw)
        at = b.find(b"PK\x01\x02")
        local = struct.unpack_from("<I", b, at + 42)[0]
        value = struct.unpack_from("<I", b, at + 16)[0] ^ 0x12345678
        struct.pack_into("<I", b, at + 16, value)
        struct.pack_into("<I", b, local + 14, value)
        return bytes(b)

    emit("20-zip-crc-invalid", "实际解压CRC错误", package(para("CRC public fixture")), rejected("zip-crc"), corrupt_crc)
    basic = package(para("resource baseline"))
    emit("21-duplicate-entry", "重复同名ZIP项", list(basic.items()) + [("word/document.xml", document(para("duplicate body")))], rejected("duplicate-entry"))
    emit("22-path-escape-entry", "ZIP越界路径", {**basic, "../outside.bin": b"PUBLIC INERT MARKER"}, rejected("path-traversal", filesystemExtractionAllowed=False))

    for count, suffix in [(2048, "at"), (2049, "over")]:
        entries = dict(basic)
        for n in range(count - len(entries)):
            entries[f"padding/p{n:04}.bin"] = b""
        emit(f"23-entry-count-{suffix}" if suffix == "at" else "24-entry-count-over", f"ZIP项数{count}", entries,
             {"profileOutcome": "container-boundary-pass" if suffix == "at" else "reject", "reason": "entry-count", "configuredEntryLimit": 2048, "expectedEntryCount": count, "scope": "Only the current shared container limit, not proof of DOCX semantic acceptance."})

    for size, identifier in [(16 * MIB, "25-part-size-at"), (16 * MIB + 1, "26-part-size-over")]:
        entries = {**basic, "padding/large.bin": b"0" * size}
        emit(identifier, f"单项实际解压字节{size}", entries, {"profileOutcome": "container-boundary-pass" if size == 16 * MIB else "reject", "reason": "part-size", "configuredPartLimit": 16 * MIB, "expectedLargePartBytes": size, "scope": "Ignored binary entries still count; semantic acceptance is separate."})

    for total, identifier in [(64 * MIB, "27-total-size-at"), (64 * MIB + 1, "28-total-size-over")]:
        entries = dict(basic)
        remaining = total - sum(len(v) for v in entries.values())
        i = 0
        while remaining:
            size = min(16 * MIB, remaining)
            entries[f"padding/total{i}.bin"] = b"0" * size
            remaining -= size
            i += 1
        emit(identifier, f"总实际解压字节{total}", entries, {"profileOutcome": "container-boundary-pass" if total == 64 * MIB else "reject", "reason": "total-size", "configuredTotalLimit": 64 * MIB, "expectedInflatedBytes": total, "scope": "Never expand all boundary payloads simultaneously; validate sequentially with bounded readers."})

    manifest = {
        "schemaVersion": 1,
        "purpose": "Public synthetic DOCX content and counterexample fixtures for a future implementation; no product pass is claimed.",
        "fixtureCount": len(cases),
        "generator": "generate.py",
        "generatorDependencies": "Python standard library only; embedded JPEG was generated once from an 8x8 uniform RGB image with bundled Pillow, not downloaded.",
        "deterministicZIPDate": "1980-01-01T00:00:00",
        "privacy": "Only authored fixed text, inert marker bytes and synthetic pixels. No real document, credential, user path, author identity or conversation.",
        "renderingStatus": "Not rendered in Word, LibreOffice, Quick Look or Farfold; structural fixtures are not evidence of full Word pagination or visual fidelity.",
        "outcomeMeaning": "profileOutcome records the candidate safety/feature expectation, not current Farfold behavior. Container boundary pass applies only to the current ZIP layer; semantic limits may be stricter.",
        "doNotExecute": "Do not open active/corrupt fixtures in a general-purpose application. No fixture needs remote loading, shell, macro execution or Agent activity.",
        "globalExpectations": {"networkRequests": 0, "newProcesses": 0, "agentCalls": 0, "automaticSends": 0, "extractionToFilesystem": False},
        "resourceReadGuidance": "Resource fixtures are tiny compressed files with up to 64MiB+1 actual content. Inspect declared metadata first; exercise only the bounded reader under test. Do not indiscriminately extract the whole corpus.",
        "notMaterialized": [{"case": "archive-bytes-over-16MiB", "reason": "Avoid a 16MiB evidence artifact; future test can construct exactly limit+1 inert bytes in its temporary directory. No pass claimed."}, {"case": "real-encrypted-Office", "reason": "No encrypted Office engine used; a flag-only ZIP is not a real encrypted DOCX and is not offered as such."}, {"case": "real-executable-VBA", "reason": "Only inert macro identity markers provided; these prove structural refusal expectations, not an actual macro sandbox."}],
        "cases": cases,
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"generated": len(cases), "archiveBytesTotal": sum(c["archiveBytes"] for c in cases), "maxArchiveBytes": max(c["archiveBytes"] for c in cases)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
