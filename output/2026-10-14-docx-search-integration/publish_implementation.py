"""Publish bounded synthetic DOCX search evidence; no build or native action."""
from pathlib import Path
import argparse, datetime, hashlib, json, subprocess

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = ROOT / 'docs/evidence/2026-10-09-capability-hardening/docx-content-search'
WORK = ROOT / 'output'

def ref(path):
    data = path.read_bytes()
    return {'path': str(path.relative_to(ROOT)), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

def read(path): return json.loads(path.read_bytes())

def put(path, value):
    with path.open('x') as f: f.write(json.dumps(value, indent=2, ensure_ascii=False) + '\n')

parser = argparse.ArgumentParser()
parser.add_argument('--browser-label', required=True)
parser.add_argument('--frontend-freeze', required=True)
parser.add_argument('--independent-review', required=True)
args = parser.parse_args()
backend = WORK / '2026-10-14-docx-search-backend'
frontend = WORK / '2026-10-14-docx-search-frontend'
browser = WORK / '2026-10-14-docx-search-browser'
independent = WORK / '2026-10-14-docx-search-independent'
freezes = [read(backend / 'source-freeze.json'), read(ROOT / args.frontend_freeze)]
sources = freezes[0]['sourceFiles'] + freezes[1]['ownedFiles']
assert len({p['path'] for p in sources}) == len(sources)
for source in sources: assert ref(ROOT / source['path']) == source, source['path']
reports = [read(browser / f'{engine}-{args.browser_label}.json') for engine in ['chromium', 'webkit']]
for report in reports:
    assert report['passed'] and report['stable'] and not report.get('failure')
    assert not report['errors'] and not report['externalRequests']
    for path, digest in report['after'].items(): assert ref(ROOT / path)['sha256'] == digest, path
assert (ROOT / args.independent_review).is_file()
assert not OUT.exists()
OUT.mkdir(parents=True)
copies = []

def copy(path, group):
    assert path.is_file() and not path.is_symlink()
    name = path.name if path.suffix in ['.png', '.docx'] else path.name + '.raw'
    target = OUT / group / name
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('xb') as f: f.write(path.read_bytes())
    assert path.read_bytes() == target.read_bytes()
    copies.append({'original': ref(path), 'published': ref(target)})

for name in ['source-freeze.json', 'handoff.json', 'run_check.py']:
    copy(backend / name, 'backend')
for stage in ['red', 'green', 'capture-green', 'pool-regression', 'format']:
    for name in ['receipt.json', 'stdout.raw', 'stderr.raw', 'inputs-before.json', 'inputs-after.json']:
        copy(backend / stage / name, 'backend/' + stage)
for path in sorted(frontend.iterdir()):
    if path.is_file() and path.suffix in ['.json', '.txt', '.raw', '.diff']:
        copy(path, 'frontend')
for folder in ['transcript-receipts', 'transcript-receipts-v2']:
    for path in sorted((frontend / folder).iterdir()):
        if path.is_file(): copy(path, 'frontend/' + folder)
for path in sorted(browser.iterdir()):
    if path.is_file() and path.name != 'budget-captures.json':
        copy(path, 'browser')
for name in ['backend-review.json', 'root-oracle-review.json', 'root-budget-oracle-review.json', 'supplement-oracle.json', 'supplement-capture.json', 'image-and-cell-barriers.docx', 'budget-reservation-finding-open.json', 'oracle-freeze.json', 'generate-supplement.py', 'frontend-browser-supplement.json']:
    copy(independent / name, 'independent')
for path in sorted((independent / 'browser-completion-receipts').iterdir()):
    if path.is_file(): copy(path, 'independent/browser-completion-receipts')
copy(ROOT / args.independent_review, 'independent')
put(OUT / 'publication.json', {'schema': 1, 'files': copies, 'boundary': 'Original synthetic fixtures and controlled test records. The 24MB generated budget capture is reproducible from the published generator and oracle and remains local. No user history, DB, credentials or official Agent records.'})
subprocess.run(['corepack', 'pnpm', 'exec', 'prettier', '--write', str(OUT / 'publication.json')], cwd=ROOT, check=True)
put(OUT / 'implementation.json', {
    'schema': 1, 'recordedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'phase': 'SOURCE_AND_CONTROLLED_BROWSER_COMPLETE_BEFORE_SEVEN',
    'change': 'Selected local DOCX attachments use bounded capture and the existing real document Worker to search validated author text. Common temporary search shows paragraph/table/story locations and visible omission scope, then rechecks the current source before navigating to its actual declared attachment.',
    'sources': sources,
    'limits': {'selectedFiles': 20, 'sourceFileBytes': 1048576, 'actualSearchableUtf8Bytes': 16777216, 'nativeReadSlots': 2, 'batchDocxParsers': 1, 'displayedHits': 200, 'queryUtf8Bytes': 256},
    'textBoundary': 'Adjacent author formatting runs join; real tabs/breaks remain separators. Images/alt text, omitted content and note markers are barriers; paragraphs/cells/stories stay separate. No generated labels, warnings, inferred Word pages or message offsets enter search.',
    'ownership': 'Current source MIME, message/thread/index/query and seven revision fields are guarded across awaits. Source size is bounded before body capture. Cancel discards late results; real OS reads keep their shared permits until return. Pending remains unknown with explicit retry only.',
    'actualChecks': {'backendTargeted': 24, 'frontendV1Targeted': 109, 'frontendV2Delta': 6, 'browsers': [{'engine': r['engine'], 'label': r['label'], 'checks': len(r['checks']), 'scenarios': len(r['scenarios']), 'sourceStable': r['stable']} for r in reports]},
    'retainedFailures': 'Backend initial oversized capture, initial missing DOCX search, prefetch reservation defect, and browser run1 collapsed omission warning are retained. Wrong test wording/story order/fixture types and run2 WebKit harness blocking a same-origin image blob are separately identified and are not claimed product defects.',
    'publication': ref(OUT / 'publication.json'),
    'remaining': ['Seven checks on final source; checkpoint commit and candidate/install validation.', 'P32 installed selected-file match and source navigation positive evidence; other document formats and unloaded attachment discovery.', 'Real Agent permission issue NEW-24, original P32 completion conditions, 29 Agents x8 and Windows remain separate.'],
    'formalApplicationStill': '9c278d82; this new DOCX search has not been installed or sent to an Agent.'
})
subprocess.run(['corepack', 'pnpm', 'exec', 'prettier', '--write', str(OUT / 'implementation.json')], cwd=ROOT, check=True)
print(json.dumps({'entry': ref(OUT / 'implementation.json'), 'publishedFiles': len(copies)}))
