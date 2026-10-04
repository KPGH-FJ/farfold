import json
import pathlib
import subprocess

base = pathlib.Path(__file__).resolve().parent
out = base / "output"
cases = [
    ("01-request-light", "request-desktop", 1440, 900),
    ("04-browser-dark", "browser-dark-narrow", 640, 900),
]
receipts = []
for source, name, width, height in cases:
    process = subprocess.run([
        "/tmp/farfold-capture-task-first-20261004", str(out / (source + ".html")),
        str(out / (name + ".png")), str(width), str(height), str(base / "layout-checks.js"),
    ], text=True, capture_output=True, timeout=25)
    receipt = {"name": name, "exit": process.returncode, "stdout": process.stdout, "stderr": process.stderr}
    receipts.append(receipt)
    print(json.dumps(receipt, ensure_ascii=False))
    if process.returncode:
        raise SystemExit(process.returncode)
(out / "capture-receipts.json").write_text(json.dumps(receipts, ensure_ascii=False, indent=2))
