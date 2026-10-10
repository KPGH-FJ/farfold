"""One ordinary writer sample for repeated text at distinct XML locations.

Only public python-docx APIs; no Farfold imports or authored XML. Normalize ZIP
entry dates for reproducibility while preserving every serialized part byte.
"""
from datetime import datetime, timezone
from io import BytesIO
import hashlib
import json
from pathlib import Path
import zipfile

import docx
from docx import Document
from docx.shared import Pt, RGBColor

OUT = Path(__file__).resolve().parent
TEXT = "DUPLICATE 0 false cafe"


def create():
    assert docx.__version__ == "1.2.0"
    document = Document()
    props = document.core_properties
    props.title = "Repeated text locations"
    props.author = "Farfold public fixture"
    props.last_modified_by = props.author
    props.created = props.modified = datetime(2026, 10, 10, tzinfo=timezone.utc)
    props.revision = 1
    document.styles["Normal"].font.name = "Arial"
    document.styles["Normal"].font.size = Pt(11)
    document.styles["Title"].font.color.rgb = RGBColor(0, 0, 0)
    document.add_heading("Repeated text locations", 0)
    document.add_paragraph(TEXT)
    document.add_paragraph("A different paragraph keeps the body paths distinct.")
    document.add_paragraph(TEXT)
    document.add_paragraph("")
    table = document.add_table(rows=1, cols=2)
    table.style = "Table Grid"
    table.cell(0, 0).text = TEXT
    table.cell(0, 1).text = TEXT
    document.add_paragraph("End of location sample.")
    document.sections[0].header.paragraphs[0].text = TEXT
    document.sections[0].footer.paragraphs[0].text = TEXT
    original = BytesIO()
    document.save(original)
    result = BytesIO()
    with zipfile.ZipFile(original) as source, zipfile.ZipFile(result, "w") as target:
        for entry in source.infolist():
            entry.date_time = (2026, 10, 10, 0, 0, 0)
            target.writestr(entry, source.read(entry.filename))
    with zipfile.ZipFile(original) as source, zipfile.ZipFile(result) as target:
        assert source.namelist() == target.namelist()
        assert all(source.read(name) == target.read(name) for name in source.namelist())
    return result.getvalue()


if __name__ == "__main__":
    value = create()
    assert value == create(), "Ordinary writer output must reproduce byte-for-byte"
    path = OUT / "repeated-locations.docx"
    if path.exists():
        assert path.read_bytes() == value, "Refusing to replace a retained fixture with different bytes"
    else:
        path.write_bytes(value)
    print(json.dumps({"writer": "python-docx 1.2.0", "file": path.name,
                      "sha256": hashlib.sha256(value).hexdigest(), "bytes": len(value),
                      "repeatedText": TEXT, "expectedParagraphOccurrences": 6,
                      "bodyParagraphs": 2, "tableCellParagraphs": 2, "header": 1, "footer": 1,
                      "normalization": "ZIP entry dates only; every writer part byte unchanged"}))
