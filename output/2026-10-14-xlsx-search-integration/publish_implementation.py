"""Publish exact synthetic search evidence, no test rerun or app mutation."""
from pathlib import Path
import json, hashlib, datetime, subprocess
ROOT = Path('/Users/tw/Desktop/farfold')
OUT = ROOT/'docs/evidence/2026-10-09-capability-hardening/xlsx-search'
BASE = ROOT/'output'
def ref(p):
 b=p.read_bytes(); return {'path':str(p.relative_to(ROOT)), 'bytes':len(b), 'sha256':hashlib.sha256(b).hexdigest()}
def read(p): return json.loads(p.read_bytes())
def put(p,v):
 with p.open('x') as f: f.write(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
backend=BASE/'2026-10-14-xlsx-search-backend'; frontend=BASE/'2026-10-14-xlsx-search-frontend'; browser=BASE/'2026-10-14-xlsx-search-browser'; independent=BASE/'2026-10-14-xlsx-search-independent'
sources=read(backend/'source-freeze.json')['files']+read(frontend/'source-freeze-v1.json')['ownedFiles']
assert len(sources)==23 and len({r['path'] for r in sources})==23
for r in sources: assert ref(ROOT/r['path'])==r,r['path']
reports=[read(browser/f'{engine}-run1.json') for engine in ['chromium','webkit']]
for r in reports:
 assert r['passed'] and r['stable'] and not r['errors'] and not r['externalRequests'] and not r.get('failure')
 assert len(r['checks'])==162 and len(r['scenarios'])==17 and all(c['pass'] for c in r['checks'])
 for path,digest in r['after'].items(): assert ref(ROOT/path)['sha256']==digest,path
assert (independent/'browser-review.json').is_file()
assert not OUT.exists(); OUT.mkdir(parents=True)
copies=[]
def copy(p,group):
 assert p.is_file() and not p.is_symlink()
 target=OUT/group/(p.name if p.suffix in ['.png','.xlsx'] else p.name+'.raw')
 target.parent.mkdir(parents=True,exist_ok=True)
 with target.open('xb') as f:f.write(p.read_bytes())
 assert p.read_bytes()==target.read_bytes()
 copies.append({'original':ref(p),'published':ref(target)})
for base,group in [(backend,'backend'),(frontend,'frontend')]:
 for p in sorted(base.rglob('*')):
  if p.is_file() and '__pycache__' not in p.parts: copy(p,str(Path(group)/p.parent.relative_to(base)))
for p in sorted(browser.iterdir()):
 if p.is_file() and p.name!='budget-captures.json':copy(p,'browser')
for p in sorted(independent.rglob('*')):
 if p.is_file() and '__pycache__' not in p.parts:copy(p,str(Path('independent')/p.parent.relative_to(independent)))
put(OUT/'publication.json',{'schema':1,'files':copies,'boundary':'Authored synthetic fixtures, source snapshots and controlled verification records only. Large generated budget-captures.json is reproducible and retained in its original path; strict candidate source closure includes original test inputs. No user DB, histories, credentials, installed-app or real-Agent content.'})
subprocess.run(['corepack','pnpm','exec','prettier','--write',str(OUT/'publication.json')],cwd=ROOT,check=True)
put(OUT/'verification.json',{
 'schema':1,'recordedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'phase':'SOURCE_AND_CONTROLLED_BROWSER_VERIFIED_BEFORE_FULL_CHECKS',
 'change':'Search explicitly selected local XLSX attachments through bounded native capture and the existing checked Workbook Worker. Search visible saved values, formula caches and included stored expressions as separate fields, alongside DOCX and UTF8 in the common temporary attachment-search interface.',
 'sources':sources,'limits':{'files':20,'sourceBytes':1048576,'actualUtf8TextBytes':16777216,'hits':200,'queryUtf8Bytes':256,'nativeReadSlots':2,'batchStructuredParsers':1},
 'boundaries':['Strings are decoded once; number/boolean/error/date lexemes retain precision. No generated formatting, formula evaluation, shared-formula expansion or added equals signs.','Cells, fields and sheets stay separate. Hidden/unknown/covered content is excluded; missing, empty and zero caches stay distinct. Empty visible scope does not expand to hidden sheets.','Cache and partial-scope notices remain visible outside collapsed details. Seven source fields, MIME, owner and current selection are checked across awaits and before source navigation.','Cancelled reads retain native capacity until real work ends; late results are discarded. Existing DOCX and workbook previews keep their original limits.'],
 'actualChecks':{'backendTargetedPassed':40,'frontendTargetedPassed':190,'frontendTestFiles':7,'browsers':[{'engine':r['engine'],'label':r['label'],'checks':len(r['checks']),'scenarios':len(r['scenarios']),'sourceStable':r['stable']} for r in reports],'pixels':'Root inspected all four saved result/source screenshots. Both browser runs are controlled Tauri IPC with actual production App and Workers.'},
 'retainedFailures':['Backend initial oversized search-source acceptance and frontend missing XLSX route exposed by red tests.','Frontend string-registry collection failure and oracle-only formatting failure retained with fixes and subsequent actual completions.','Root pre-browser oracle initially used numeric sheetId; corrected to the existing relationship identity before either run. Original oracle/generator and correction receipt retained. No failed browser run.'],
 'publication':ref(OUT/'publication.json'),
 'formalApplication':'52d21a3 /0.1.7 installed and independently verified in preceding DOCX slice, never launched after that replacement. New XLSX search is not installed by this record.',
 'remaining':['Full seven checks, checkpoint and candidate/install validation for this increment.','P32 installed selected-file match and source-navigation positive evidence, additional formats and unloaded attachment discovery remain open.','NEW24 permission recovery, original P32 acceptance, 29 Agents x8 and Windows remain separate and uncompleted.']})
subprocess.run(['corepack','pnpm','exec','prettier','--write',str(OUT/'verification.json')],cwd=ROOT,check=True)
print(json.dumps({'entry':ref(OUT/'verification.json'),'publishedFiles':len(copies)}))
