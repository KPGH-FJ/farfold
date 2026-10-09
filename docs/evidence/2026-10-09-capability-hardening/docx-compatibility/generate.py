"""Author ordinary public fixtures using python-docx high-level APIs only.

No Farfold parser imports, no hand-built OOXML, no external documents/assets.
Expected content is authored before serialization, not inferred from Farfold.
"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

import docx
from docx import Document
from docx.enum.section import WD_SECTION_START
from docx.shared import Inches, Pt, RGBColor
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
FIXED_DATE = datetime(2026, 10, 9, tzinfo=timezone.utc)
EXPECTED = []


def document(title):
    value = Document()
    props = value.core_properties
    props.author = "Farfold compatibility fixtures"
    props.last_modified_by = "Farfold compatibility fixtures"
    props.title = title
    props.subject = "Public synthetic compatibility sample"
    props.comments = "Authored by python-docx, not Farfold or manually written XML"
    props.created = FIXED_DATE
    props.modified = FIXED_DATE
    props.revision = 1
    value.styles["Normal"].font.name = "Arial"
    value.styles["Normal"].font.size = Pt(11)
    value.styles["Title"].font.color.rgb = RGBColor(0, 0, 0)
    value.add_heading(title, 0)
    return value


def save(value, filename, expectation):
    path = OUT / filename
    if path.exists():
        raise RuntimeError("Refusing to overwrite a retained compatibility sample")
    value.save(path)
    EXPECTED.append({"file": filename, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                     "bytes": path.stat().st_size, **expectation})


def main():
    assert docx.__version__ == "1.2.0", "Record a different writer as a different sample set"
    red = Image.new("RGB", (160, 96), (244, 235, 225))
    ImageDraw.Draw(red).rectangle((20, 20, 70, 70), fill=(180, 50, 30))
    red.save(OUT / "authored-red.png")
    blue = Image.new("RGB", (160, 96), (240, 245, 250))
    ImageDraw.Draw(blue).ellipse((70, 18, 130, 78), fill=(30, 90, 160))
    blue.save(OUT / "authored-blue.jpg", quality=95, subsampling=0)

    d = document("兼容性纪要")
    d.add_paragraph("这份公开样本用于检查普通文档的文字与列表。")
    d.add_heading("文本与样式", 1)
    p = d.add_paragraph()
    p.add_run("普通文字 ")
    p.add_run("加粗文字").bold = True
    p.add_run(" 与 ")
    p.add_run("斜体 café").italic = True
    p.add_run(" 和普通结尾。")
    d.add_paragraph("Unicode café naïve Ελληνικά 中文")
    d.add_paragraph("0")
    d.add_paragraph("false")
    d.add_paragraph("")
    d.add_paragraph("  保留  两处空格  ")
    d.add_heading("准备步骤", 2)
    for text in ["收集材料", "核对数值", "保存结果"]:
        d.add_paragraph(text, style="List Number")
    for text in ["不自动发送", "不读取外部文件"]:
        d.add_paragraph(text, style="List Bullet")
    save(d, "01-unicode-lists.docx", {
        "requiredBodyTextInOrder": ["兼容性纪要", "这份公开样本用于检查普通文档的文字与列表。", "文本与样式",
                                    "普通文字 加粗文字 与 斜体 café 和普通结尾。", "Unicode café naïve Ελληνικά 中文",
                                    "0", "false", "  保留  两处空格  ", "准备步骤", "收集材料", "核对数值", "保存结果",
                                    "不自动发送", "不读取外部文件"],
        "emptyParagraphs": 1, "numberedItems": ["收集材料", "核对数值", "保存结果"],
        "numberLabels": ["1.", "2.", "3."], "bulletItems": ["不自动发送", "不读取外部文件"],
        "directRunFormatting": {"加粗文字": "bold", "斜体 café": "italic"},
    })

    d = document("表格与图片记录")
    d.sections[0].header.paragraphs[0].text = "公开兼容性样本 页眉"
    d.sections[0].footer.paragraphs[0].text = "公开兼容性样本 页脚"
    d.add_paragraph("下表包含横向和纵向合并，图片均为本地生成的简单色块。")
    table = d.add_table(rows=4, cols=3)
    table.style = "Table Grid"
    table.cell(0, 0).merge(table.cell(0, 1)).text = "横向合并"
    table.cell(0, 2).text = "说明"
    table.cell(1, 0).merge(table.cell(2, 0)).text = "纵向合并"
    for row, col, text in [(1, 1, "0"), (1, 2, "false"), (2, 1, ""), (2, 2, "中文"),
                           (3, 0, "尾行"), (3, 1, "12.50"), (3, 2, "结束")]:
        table.cell(row, col).text = text
    d.add_heading("红色方块", 1)
    d.add_picture(str(OUT / "authored-red.png"), width=Inches(2))
    d.add_paragraph("PNG 红色方块说明")
    d.add_heading("蓝色圆形", 1)
    d.add_picture(str(OUT / "authored-blue.jpg"), width=Inches(2))
    d.add_paragraph("JPEG 蓝色圆形说明")
    save(d, "02-table-images-stories.docx", {
        "requiredText": ["表格与图片记录", "横向合并", "说明", "纵向合并", "0", "false", "中文", "尾行", "12.50", "结束",
                         "红色方块", "PNG 红色方块说明", "蓝色圆形", "JPEG 蓝色圆形说明"],
        "tables": [{"rows": 4, "gridColumns": 3, "horizontalSpan": {"row": 0, "column": 0, "span": 2},
                    "verticalSpan": {"row": 1, "column": 0, "span": 2}, "emptyCell": [2, 1]}],
        "header": "公开兼容性样本 页眉", "footer": "公开兼容性样本 页脚",
        "images": [{"asset": "authored-red.png", "width": 160, "height": 96, "mime": "image/png"},
                   {"asset": "authored-blue.jpg", "width": 160, "height": 96, "mime": "image/jpeg"}],
    })

    d = document("分节项目记录")
    d.sections[0].header.paragraphs[0].text = "第一节页眉"
    d.sections[0].footer.paragraphs[0].text = "第一节页脚"
    d.add_heading("第一组记录", 1)
    first = [f"记录 {index:02d} 中文与 Unicode café 内容保持顺序。" for index in range(1, 17)]
    for text in first:
        d.add_paragraph(text)
    section = d.add_section(WD_SECTION_START.NEW_PAGE)
    section.header.is_linked_to_previous = False
    section.footer.is_linked_to_previous = False
    section.header.paragraphs[0].text = "第二节页眉"
    section.footer.paragraphs[0].text = "第二节页脚"
    d.add_heading("第二组记录", 1)
    second = [f"记录 {index:02d} 第二节保留正文和结尾。" for index in range(17, 33)]
    for text in second:
        d.add_paragraph(text)
    save(d, "03-sections.docx", {"requiredBodyTextInOrder": ["分节项目记录", "第一组记录", *first, "第二组记录", *second],
                                 "sections": 2, "headers": ["第一节页眉", "第二节页眉"],
                                 "footers": ["第一节页脚", "第二节页脚"],
                                 "qualification": "Section ownership and visible stories are separate from exact Word pagination."})

    (OUT / "expectations.json").write_text(json.dumps({"writer": "python-docx 1.2.0", "basis": "Authored API inputs before serialization, independent of Farfold parser", "samples": EXPECTED}, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"writer": docx.__version__, "files": [{"file": x["file"], "bytes": x["bytes"], "sha256": x["sha256"]} for x in EXPECTED]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
