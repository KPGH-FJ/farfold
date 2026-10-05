"""Capture only exported synthetic HTML with an isolated headless browser."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import hashlib
import json
import os
import signal
import subprocess
import time

HTML = Path('/tmp/farfold-ui-consistency-html-2026-10-03')
OUT = Path('/tmp/farfold-ui-consistency-capture-2026-10-03')
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
CASES = [
    ('01-account-key', 1280, 820),
    ('13-single-terminal', 1280, 820),
    ('14-key-detail', 1280, 820),
    ('15-api-old-auth', 1280, 820),
    ('16-program-ready', 1280, 820),
    ('17-program-missing', 1280, 820),
    ('14-key-detail', 520, 780),
    ('16-program-ready', 520, 780),
]

def capture(case):
    name, width, height = case
    ident = f'{name}-{width}'
    output = OUT / f'{ident}.png'
    if output.exists():
        output.unlink()
    with (OUT / f'{ident}.log').open('w') as log:
        process = subprocess.Popen([
            CHROME, '--headless', '--no-first-run', '--no-default-browser-check',
            '--disable-background-networking', '--disable-extensions', '--disable-sync',
            '--disable-gpu', '--hide-scrollbars',
            f'--user-data-dir={OUT / (ident + "-profile")}',
            f'--window-size={width},{height}', f'--screenshot={output}',
            (HTML / f'{name}.html').as_uri(),
        ], stdout=log, stderr=log, start_new_session=True)
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and not output.exists():
                if process.poll() is not None:
                    break
                time.sleep(0.2)
            if not output.exists():
                raise RuntimeError(f'No screenshot for {ident}')
            time.sleep(0.2)
        finally:
            # The process group belongs exclusively to this capture invocation.
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
    return {'case': name, 'viewport': [width, height], 'file': output.name,
            'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
            'source': str(HTML / f'{name}.html'), 'synthetic': True}

OUT.mkdir(exist_ok=True)
with ThreadPoolExecutor(max_workers=2) as pool:
    rows = list(pool.map(capture, CASES))
(OUT / 'captures.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'captured': len(rows), 'output': str(OUT)}))
