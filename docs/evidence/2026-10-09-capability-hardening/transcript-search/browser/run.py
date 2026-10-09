"""Owned isolated headless Chromium; synthetic React fixture only, no real app."""
import html
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile

folder = Path(__file__).resolve().parent
name = sys.argv[1] if len(sys.argv) > 1 else "browser-result"
url = "http://127.0.0.1:1457/docs/evidence/2026-10-09-capability-hardening/transcript-search/browser/index.html"
with tempfile.TemporaryDirectory(prefix="farfold-search-chrome-") as profile:
    command = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-extensions", "--disable-component-update", "--enable-precise-memory-info", "--js-flags=--expose-gc", "--dump-dom", "--virtual-time-budget=12000", url]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        output, errors = process.communicate(timeout=60)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        output, errors = process.communicate()
        raise RuntimeError("owned Chromium exceeded 60 seconds")
    match = re.search(r'<pre id="result">(.*?)</pre>', output, re.S)
    raw = html.unescape(match.group(1)) if match else "missing result"
    (folder / f"{name}.json").write_text(raw + "\n")
    (folder / f"{name}.stderr.txt").write_text(errors)
    try:
        result = json.loads(raw)
    except ValueError:
        print(raw[:1000]); sys.exit(2)
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get("passed") else 1)
