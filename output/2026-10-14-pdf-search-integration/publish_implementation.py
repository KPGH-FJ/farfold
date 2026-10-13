"""Publish exact synthetic PDF-search evidence; no checks, App, Agent or user-data reads."""
from pathlib import Path
import json, hashlib, datetime, subprocess
ROOT = Path('/Users/tw/Desktop/farfold')
OUT = ROOT / 'docs/evidence/2026-10-09-capability-hardening/pdf-search'
BASE = ROOT / 'output'
def ref(p):
 b=p.read_bytes(); return {'path':str(p.relative_to(ROOT)), 'bytes':len(b), 'sha256':hashlib.sha256(b).hexdigest()}
def read(p): return json.loads(p.read_bytes())
def put(p,v):
 with p.open('x') as f: f.write(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
backend=BASE/'2026-10-14-pdf-search-backend'; frontend=BASE/'2026-10-14-pdf-search-frontend'; browser=BASE/'2026-10-14-pdf-search-browser'; independent=BASE/'2026-10-14-pdf-search-independent'; research=BASE/'2026-10-14-pdf-search-research'
backend_freeze=read(backend/'source-freeze.json'); frontend_freeze=read(frontend/'source-freeze-v1.json')
sources=backend_freeze['files']+frontend_freeze['files']
assert len(sources)==17 and len({r['path'] for r in sources})==17
for r in sources:
 actual=ref(ROOT/r['path']); assert all(actual[k]==r[k] for k in actual),r['path']
reports=[read(browser/name) for name in ['chromium-run3.json','webkit-run1.json']]
for r in reports:
 assert r['passed'] and r['stable'] and not r['errors'] and not r['externalRequests'] and not r.get('failure')
 assert len(r['checks'])==76 and len(r['scenarios'])==11 and all(c['pass'] for c in r['checks'])
 for path,digest in r['after'].items(): assert ref(ROOT/path)['sha256']==digest,path
for name in ['backend-review.json','frontend-review.json','frontend-evidence-review.json','fixture-review.json','browser-review.json']:
 assert (independent/name).is_file(),name
assert not OUT.exists(); OUT.mkdir(parents=True)
copies=[]
def copy(p,group):
 assert p.is_file() and not p.is_symlink()
 target=OUT/group/(p.name if p.suffix in ['.png','.pdf'] else p.name+'.raw')
 target.parent.mkdir(parents=True,exist_ok=True)
 with target.open('xb') as f:f.write(p.read_bytes())
 assert p.read_bytes()==target.read_bytes()
 copies.append({'original':ref(p),'published':ref(target)})
for base,group in [(backend,'backend'),(frontend,'frontend'),(independent,'independent'),(research,'research')]:
 for p in sorted(base.rglob('*')):
  if p.is_file() and '__pycache__' not in p.parts: copy(p,str(Path(group)/p.parent.relative_to(base)))
for p in sorted(browser.iterdir()):
 if p.is_file():copy(p,'browser')
put(OUT/'publication.json',{'schema':1,'files':copies,'boundary':'Only independently authored synthetic fixtures, source snapshots and controlled verification records. No user database, histories, credentials, installed-app content or real-Agent output.'})
subprocess.run(['corepack','pnpm','exec','prettier','--write',str(OUT/'publication.json')],cwd=ROOT,check=True)
put(OUT/'verification.json',{
 'schema':1,'recordedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'phase':'SOURCE_AND_CONTROLLED_BROWSER_VERIFIED_BEFORE_FULL_CHECKS',
 'change':'Search explicitly selected local PDFs through bounded native capture and existing checked PDF Workers, in the common temporary attachment search. Fixed scope is all pages of decoded text, possibly invisible and always partial. Each item is matched separately; page and item locations remain attached to the source.',
 'sources':sources,'limits':{'files':20,'sourceBytes':1048576,'actualSearchUtf8Bytes':16777216,'hits':200,'queryUtf8Bytes':256,'nativeReadSlots':2,'batchStructuredParsers':1,'pdfPages':1000,'pdfItems':100000,'pdfCompleteRepresentationBytes':262144,'pdfTimeoutMs':15000},
 'boundaries':['Existing file selection plus explicit Start, with scope before reading and persistent partial result warning; no extra consent checkbox or automatic Agent input.','No concatenation across items/pages, normalization or generated wrapper matches. No OCR; image-only files report no extracted text. Encrypted, damaged and over-limit whole reads publish no prefix results.','Seven source fields, full bytes/hash, MIME, owner and selection are checked across asynchronous work and before source navigation. Captures are immutable before hashing.','Source navigation locates the actual message attachment, not an asserted PDF page viewer position. Original PDF input remains at its previous 32 MiB limit.'],
 'actualChecks':{'backendTargetedPassed':18,'frontendTargetedPassed':262,'frontendTestFiles':9,'browsers':[{'engine':r['engine'],'label':r['label'],'checks':len(r['checks']),'scenarios':len(r['scenarios']),'sourceStable':r['stable']} for r in reports],'pixels':'Root inspected all four final screenshots. Production App and real PDF/DOCX/XLSX Workers; controlled Tauri file returns, no native IO or real Agent.'},
 'retainedFailures':['Backend deliberately exposed new search entry accepting 1 MiB+1 via old input path, actual exit101; new bounded path passed.','Frontend missing PDF route red and later two test parameter-shape errors preserved separately; final targeted262/type/format passed.','Chromium run1 interrupted by Vite first PDF dependency optimization reload; explicit preload added to test server.','Chromium run2 had 47 successful assertions then a test selector checked successful-partial text for the explicit no-text error; only the runner assertion corrected, product unchanged.'],
 'publication':ref(OUT/'publication.json'),
 'formalApplication':'c89b8f82 /0.1.7 installed in prior XLSX slice, never launched after that replacement. PDF search is not installed by this record.',
 'remaining':['Seven integration checks, checkpoint and candidate/install verification for this increment.','Native selected-attachment positive search and source navigation, unloaded attachment discovery and complete P32 remain unverified.','NEW24 permission recovery, 29 Agents x8 and Windows remain separate and incomplete.']})
subprocess.run(['corepack','pnpm','exec','prettier','--write',str(OUT/'verification.json')],cwd=ROOT,check=True)
print(json.dumps({'entry':ref(OUT/'verification.json'),'publishedFiles':len(copies)}))
