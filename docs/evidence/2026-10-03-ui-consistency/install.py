"""Replace the exact closed Farfold application; do not launch or inspect Agents."""
import hashlib
import json
import plistlib
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = Path(__file__).resolve().parent
RECEIPT = json.loads((OUT / 'source-after-build.json').read_text())
BUILT = ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app'
FORMAL = Path('/Applications/Farfold.app')
DATA = Path('/Users/tw/Library/Application Support/ai.farfold.desktop')

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def files(base):
    if base.is_symlink() or not base.is_dir() or any(p.is_symlink() for p in base.rglob('*')):
        raise SystemExit('STOP unexpected exact application path')
    info = plistlib.loads((base / 'Contents/Info.plist').read_bytes())
    if info['CFBundleIdentifier'] != 'ai.farfold.desktop':
        raise SystemExit('STOP application identifier mismatch')
    return {str(p.relative_to(base)): sha(p) for p in sorted(base.rglob('*')) if p.is_file()}

def closed():
    check = subprocess.run(['/usr/bin/pgrep', '-x', 'farfold'], capture_output=True)
    if check.returncode != 1:
        raise SystemExit('STOP Farfold is running or process check failed')

def signature(path):
    result = subprocess.run(['/usr/bin/codesign','--verify','--deep','--strict','--verbose=2',str(path)],capture_output=True,text=True)
    if result.returncode:
        raise SystemExit('STOP signature verification failed')
    return {'exitCode':result.returncode,'output':result.stderr.strip()}

def data_snapshot():
    # Counts and byte hashes only: never select settings values, Agent launch
    # configuration, account files, terminal content or credential material.
    connection = sqlite3.connect((DATA / 'farfold.sqlite3').as_uri() + '?mode=ro', uri=True)
    connection.execute('PRAGMA query_only=ON')
    counts = {name: connection.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0]
              for name in ['sessions','agents','settings','dismissed_sessions']}
    connection.close()
    return {'tableCounts':counts,'databaseFiles':{name:sha(DATA/name) for name in ['farfold.sqlite3','farfold.sqlite3-wal','farfold.sqlite3-shm'] if (DATA/name).exists()}}

closed()
source = {name:sha(ROOT/name) for name in RECEIPT['source']['files']}
if source != RECEIPT['source']['files']:
    raise SystemExit('STOP production inputs changed')
candidate = files(BUILT)
previous = files(FORMAL)
if candidate != RECEIPT['candidate']['files'] or previous != RECEIPT['formal']['files']:
    raise SystemExit('STOP candidate or formal application changed')
signature(BUILT)
signature(FORMAL)
before = data_snapshot()
closed()
subprocess.run(['/usr/bin/ditto', str(BUILT), str(FORMAL)], check=True)
actual = files(FORMAL)
if actual != candidate:
    raise SystemExit('STOP installed files differ')
verified = signature(FORMAL)
after = data_snapshot()
if before != after:
    raise SystemExit('STOP replacement changed Farfold data')
closed()
result = {'atUtc':datetime.now(timezone.utc).isoformat(),'installed':str(FORMAL),
          'bundleIdentifier':'ai.farfold.desktop','oldBinarySha256':previous['Contents/MacOS/farfold'],
          'binarySha256':actual['Contents/MacOS/farfold'],'files':actual,'signature':verified,
          'sourceManifestSha256':RECEIPT['source']['summary']['manifestSha256'],
          'sourceInputCount':len(source),'sourceInputsUnchanged':True,
          'dataBefore':before,'dataAfter':after,'dataBeforeAfterEqual':True,
          'userConfirmedUpdate':True,'processAbsentBeforeAndAfter':True,
          'appLaunched':False,'agentActions':[]}
(OUT/'installation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:result[k] for k in ['installed','binarySha256','signature','sourceInputCount','dataBeforeAfterEqual','processAbsentBeforeAndAfter','appLaunched']}))
print(json.dumps({'tableCounts':before['tableCounts']}))
