"""Independent ordinary-writer XLSX fixtures; never imports Farfold code.

Run with the bundled Python (openpyxl 3.1.5 already installed). Only this
script's directory receives outputs. No spreadsheet engine is launched.
"""

from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
from pathlib import Path
import json
import re
import zipfile

import openpyxl
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

from oracle import inspect_workbook


HERE = Path(__file__).resolve().parent
STAMP = "2026-10-10T00:00:00Z"
ZIP_DATE = (2026, 10, 10, 0, 0, 0)
MAIN = "数据一"
DUPLICATE = "副本'与&同文"
NAMES = [MAIN, DUPLICATE, "隐藏资料", "深藏资料"]


def digest(data):
    return sha256(data).hexdigest()


def canonical_zip(parts):
    """Normalize archive metadata; only core timestamps change XML values."""
    target = BytesIO()
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(parts):
            data = parts[name]
            if name == "docProps/core.xml":
                for field in ("created", "modified"):
                    pattern = rb"(<dcterms:" + field.encode() + rb"\b[^>]*>)[^<]*(</dcterms:" + field.encode() + rb">)"
                    data, count = re.subn(pattern, lambda m: m[1] + STAMP.encode() + m[2], data)
                    assert count == 1, f"Unexpected writer core metadata: {field}"
            info = zipfile.ZipInfo(name, date_time=ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o600 << 16
            archive.writestr(info, data)
    return target.getvalue()


def ordinary_writer(revision):
    book = Workbook()
    sheet = book.active
    sheet.title = MAIN
    book.properties.creator = "Farfold controlled fixture"
    book.properties.lastModifiedBy = "Farfold controlled fixture"
    book.properties.created = datetime(2026, 10, 10, tzinfo=timezone.utc)
    book.properties.modified = book.properties.created
    headers = ["数值", "布尔", "写入空文本", "未存储空位", "带样式空位", "公式无缓存", "日期", "重复文字一", "重复文字二"]
    for column, value in enumerate(headers, 1):
        cell = sheet.cell(1, column, value)
        cell.font = Font(name="Arial", size=10, bold=True)
        cell.fill = PatternFill(fill_type="solid", fgColor="E5E7EB")
        cell.alignment = Alignment(vertical="center")
    sheet["A2"] = 0 if revision == 1 else 17
    sheet["B2"] = False if revision == 1 else True
    sheet["C2"] = ""
    # D2 deliberately has no authored Cell and no style.
    sheet["E2"].number_format = "0.00"
    sheet["F2"] = "=1+1" if revision == 1 else "=SUM(A2,2)"
    sheet["G2"] = datetime(2026, 10, 10 if revision == 1 else 11)
    sheet["G2"].number_format = "yyyy-mm-dd"
    sheet["H2"] = sheet["I2"] = "相同内容" if revision == 1 else "第二版相同内容"
    for name in ("A", "B", "C", "D", "E", "F", "G", "H", "I"):
        sheet.column_dimensions[name].width = 17
    sheet.row_dimensions[1].height = 22
    sheet.freeze_panes = "A2"

    # Visible anchor crosses both 100-row and 24-column windows in v1.
    cross = "X99:AA102" if revision == 1 else "X99:Z100"
    sheet.merge_cells(cross)
    sheet["X99"] = "跨窗口合并原锚点" if revision == 1 else "第二版缩小合并"
    sheet["X99"].alignment = Alignment(wrap_text=True, vertical="center")
    sheet["X99"].border = Border(bottom=Side(style="thin", color="808080"))
    # Only the real top-left anchor is hidden; visible fragments must not leak it.
    hidden = "V10:W12" if revision == 1 else "V10:W11"
    sheet.merge_cells(hidden)
    sheet["V10"] = "隐藏原锚点：需明确显示隐藏内容"
    sheet.row_dimensions[10].hidden = True
    sheet.column_dimensions["V"].hidden = True
    sheet["AB205" if revision == 1 else "Z105"] = "末尾稀疏位置"

    duplicate = book.copy_worksheet(sheet)
    duplicate.title = DUPLICATE
    hidden_sheet = book.copy_worksheet(sheet)
    hidden_sheet.title = NAMES[2]
    hidden_sheet.sheet_state = "hidden"
    very_hidden = book.copy_worksheet(sheet)
    very_hidden.title = NAMES[3]
    very_hidden.sheet_state = "veryHidden"
    if revision == 2:
        book.move_sheet(duplicate, offset=-1)
        sheet.title = "数据一已改名"
        sheet.sheet_state = "hidden"
        hidden_sheet.sheet_state = "visible"
    book.active = 0
    buffer = BytesIO()
    book.save(buffer)
    with zipfile.ZipFile(BytesIO(buffer.getvalue())) as archive:
        parts = {name: archive.read(name) for name in archive.namelist()}
    # Apart from timestamps/package metadata, preserve all ordinary-writer XML.
    result = canonical_zip(parts)
    with zipfile.ZipFile(BytesIO(result)) as archive:
        for name, data in parts.items():
            if name != "docProps/core.xml":
                assert archive.read(name) == data
    return result


def nonordinal_relationships(data):
    """Explicit controlled derivative, not claimed as unmodified writer output."""
    with zipfile.ZipFile(BytesIO(data)) as archive:
        parts = {name: archive.read(name) for name in archive.namelist()}
    mapping = {"rId1": "sheet-main", "rId2": "rel_17", "rId3": "hidden.note", "rId4": "veryHidden_2"}
    for name, attribute in [("xl/workbook.xml", "r:id"), ("xl/_rels/workbook.xml.rels", "Id")]:
        content = parts[name]
        for old, new in mapping.items():
            needle = f'{attribute}="{old}"'.encode()
            assert content.count(needle) == 1
            content = content.replace(needle, f'{attribute}="{new}"'.encode())
        parts[name] = content
    return canonical_zip(parts), mapping


def main():
    assert openpyxl.__version__ == "3.1.5", "Recheck fixture serialization before changing the writer version"
    results = {}
    for revision in (1, 2):
        data = ordinary_writer(revision)
        assert data == ordinary_writer(revision), "Deterministic build failed"
        results[f"positions-v{revision}.xlsx"] = data
    derivative, mapping = nonordinal_relationships(results["positions-v1.xlsx"])
    results["positions-v1-nonordinal-ids.xlsx"] = derivative
    for name, data in results.items():
        (HERE / name).write_bytes(data)
    oracle = {name: inspect_workbook(HERE / name) for name in results}
    first = oracle["positions-v1.xlsx"]
    second = oracle["positions-v2.xlsx"]
    variant = oracle["positions-v1-nonordinal-ids.xlsx"]
    assert [s["relationshipId"] for s in first["sheets"]] == ["rId1", "rId2", "rId3", "rId4"]
    # The writer may allocate equivalent copied styles separately; duplicate
    # content must retain values/formulas/coordinates, not a style table index.
    content = lambda cells: {key:{k:v for k,v in value.items() if k != "styleId"} for key,value in cells.items()}
    assert content(first["sheets"][0]["cells"]) == content(first["sheets"][1]["cells"])
    cells = first["sheets"][0]["cells"]
    assert cells["A2"]["rawValue"] == "0" and cells["B2"]["rawValue"] == "0"
    assert cells["A2"]["type"] == "n" and cells["B2"]["type"] == "b"
    assert "D2" not in cells and cells["E2"]["rawValue"] is None
    assert cells["F2"]["formula"] == "1+1" and cells["F2"]["rawValue"] is None
    assert first["sheets"][0]["merges"]["X99:AA102"] == {"fromRow":99,"toRow":102,"fromColumn":24,"toColumn":27}
    assert first["sheets"][0]["rows"]["10"]["hidden"] is True
    assert any(c["min"] == 22 and c["hidden"] for c in first["sheets"][0]["columns"])
    assert second["sheets"][0]["relationshipId"] == first["sheets"][0]["relationshipId"]
    assert second["sheets"][0]["name"] != first["sheets"][0]["name"]
    assert second["sheets"][1]["state"] == "hidden" and first["sheets"][0]["state"] == "visible"
    assert [s["relationshipId"] for s in variant["sheets"]] == list(mapping.values())
    for a, b in zip(first["sheets"], variant["sheets"]):
        assert a["cells"] == b["cells"] and a["merges"] == b["merges"]
    manifest = {
        "kind":"Independent XLSX location fixtures; not product acceptance",
        "writer":{"name":"openpyxl","version":openpyxl.__version__,"license":"MIT","releaseDate":"2024-06-28","source":"https://pypi.org/project/openpyxl/3.1.5/","usage":"Existing bundled Python library; no install or product dependency changes"},
        "construction":{"ordinary":["positions-v1.xlsx","positions-v2.xlsx"],"ordinaryApi":"Workbook, cell values/styles, merge_cells, row/column dimensions, copy_worksheet, move_sheet, save","normalization":"Fixed ZIP metadata and docProps/core.xml created/modified timestamp text only; all other ordinary writer part bytes preserved and asserted","controlledDerivative":{"file":"positions-v1-nonordinal-ids.xlsx","from":"positions-v1.xlsx","onlyChanges":"Four sheet r:id attributes and matching workbook relationship Id attributes","mapping":mapping}},
        "files":{name:{"sha256":digest(data),"bytes":len(data)} for name,data in results.items()},
        "oracle":"oracle.json generated by stdlib zipfile/ElementTree, without openpyxl or Farfold imports; real r:id resolves actual worksheet part before cells/merges/hidden fields are read",
        "intendedCases":["Same content, different sheet names and relationship IDs","Numeric zero / false / explicit writer empty-string record / absent D2 / style-only blank E2 / F2 formula without cached result","X99:AA102 full merge across both 100-row and 24-column windows","V10:W12 original top-left anchor hidden by row10 and columnV","visible / hidden / veryHidden sheets","v2 reuses rId1 for a reordered different sheet; prior sheet renamed and hidden; values/merge bounds/extent also change","nonordinal legal relationship IDs are not inferred from tab positions or rId digits"],
        "samePathRevisionRecipe":["In a separate future task-owned test location, copy positions-v1.xlsx to a fixed current.xlsx and capture it normally.","Replace only that controlled current.xlsx with positions-v2.xlsx, then capture again. These fixture files are immutable inputs; do not overwrite either source.","Expect a different full-file SHA and metadata version. Do not reuse a VerifiedFile from v1 or automatically retarget the old rId1 position."],
        "reproduction":{"command":"/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 docs/evidence/2026-10-09-capability-hardening/workbook-feedback/fixtures/generate.py","check":"Each ordinary revision generated twice in memory and compared byte-for-byte before writing; stdlib CRC and literal coordinate assertions then checked","sourceHashes":{n:digest((HERE/n).read_bytes()) for n in ("generate.py","oracle.py")}},
        "limits":["Self-authored public synthetic content serialized by a common independent writer; not a user file, Excel-authored file, or a comprehensive workbook compatibility corpus.","Formula caches deliberately remain absent; no formula evaluation or Office process ran.","An authored empty string may serialize as an empty inlineStr record without an is/t node; oracle reports the actual record, not an invented displayed value.","This generator does not run Farfold parser/Worker/UI/native capture/Agent. Subsequent parser-preflight and verification receipts separately record any authorized product call; no feedback feature is marked passed by generation.","No arbitrary rectangle feedback or DOCX scope is implied by these XLSX fixtures.","No screenshot/render fidelity claim; structural ZIP/XML positions are the intended independent oracle."],
    }
    (HERE / "oracle.json").write_text(json.dumps(oracle,ensure_ascii=False,indent=2)+"\n")
    (HERE / "manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n")
    print(json.dumps({"writer":openpyxl.__version__,"files":manifest["files"],"independentChecks":"passed","productTestsRun":False},ensure_ascii=False,indent=2))


if __name__ == "__main__":
    main()
