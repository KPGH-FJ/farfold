import json
import pathlib
import subprocess

base = pathlib.Path(__file__).resolve().parent
out = base / "output"
cases = [
    ("01-request-light", "request-desktop", 1440, 900),
    ("02-request-dark", "request-dark", 1440, 900),
    ("01-request-light", "request-narrow", 640, 900),
    ("03-browser-light", "browser-desktop", 1440, 900),
    ("04-browser-dark", "browser-dark-narrow", 640, 900),
    ("05-conversation-light", "conversation-narrow", 640, 900),
    ("07-browser-pending-dark", "browser-pending-narrow", 640, 900),
]
full = out / "06-full-layout.html"
full.write_text((out / "03-browser-light.html").read_text().replace("生产组件受控视觉：03-browser-light", "生产组件受控视觉：full-layout"))
cases.append(("06-full-layout", "browser-full", 1440, 900))
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
