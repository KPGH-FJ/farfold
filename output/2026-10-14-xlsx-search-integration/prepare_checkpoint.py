"""Prepare exact reviewed XLSX checkpoint paths; never changes the index."""
import hashlib,json,subprocess
from pathlib import Path
ROOT=Path('/Users/tw/Desktop/farfold'); OUT=ROOT/'output/2026-10-14-xlsx-search-integration'; BASE=ROOT/'docs/evidence/2026-10-09-capability-hardening'
def read(p):return json.loads(p.read_bytes())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def ref(p):return {'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'sha256':sha(p)}
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT).decode().strip()=='a07392822ec6a0beaa7e2508ac9fc8ee7795d83d'
assert not subprocess.check_output(['git','diff','--cached','--name-only'],cwd=ROOT)
s=read(OUT/'checks-run/summary.json');assert s['allPassed'] and s['completedCount']==s['requiredCommandsExecuted']==7 and s['sourceStable'] and s['sourceMembershipStable'] and s['protectedUnchanged']
f=read(OUT/'checks-freeze/freeze.json');assert not f['changesSincePreparation']
for name,digest in {**f['inputs'],**f['protected']}.items():assert sha(ROOT/name)==digest,name
sources=read(ROOT/'output/2026-10-14-xlsx-search-backend/source-freeze.json')['files']+read(ROOT/'output/2026-10-14-xlsx-search-frontend/source-freeze-v1.json')['ownedFiles'];assert len(sources)==23
paths=set()
for r in sources:assert ref(ROOT/r['path'])==r;paths.add(r['path'])
for name in ['docs/status.md','docs/architecture.md','plans/agent-access.md','docs/evidence/2026-10-09-capability-hardening/README.md']:
 assert name in f['inputs'];paths.add(name)
tracked=set(subprocess.check_output(['git','ls-files','-z'],cwd=ROOT).decode().rstrip('\0').split('\0'))
aux=sorted(n for n in f['inputs'] if n.startswith('output/') and n not in tracked)
assert all(n.startswith('output/2026-10-14-xlsx-search-') for n in aux)
paths.update(aux)
for folder in ['xlsx-search','xlsx-search-checks']:
 directory=BASE/folder
 for pair in read(directory/'publication.json')['files']:
  for key in ['original','published']:assert ref(ROOT/pair[key]['path'])==pair[key]
  assert pair['original']['sha256']==pair['published']['sha256']
 for p in directory.rglob('*'):
  assert not p.is_symlink()
  if p.is_file():paths.add(str(p.relative_to(ROOT)))
review=BASE/'xlsx-search-review';review.mkdir(exist_ok=False)
for n in ['publication-review.json','docs-review.json','inventory-review.json','engineering-review.json']:
 p=ROOT/'output/2026-10-14-xlsx-search-independent'/n
 target=review/(n+'.raw');target.write_bytes(p.read_bytes());assert sha(target)==sha(p);paths.add(str(target.relative_to(ROOT)))
for n in ['publisher-correction.json','publish_implementation-v1.py.raw']:
 p=OUT/n;target=review/(n if n.endswith('.raw') else n+'.raw');target.write_bytes(p.read_bytes());assert sha(target)==sha(p);paths.add(str(target.relative_to(ROOT)))
record=review/'checkpoint-scope.json';record.write_text(json.dumps({'phase':'CHECKPOINT_AFTER_SEVEN','scope':'Exact XLSX search increment, four current docs, scoped evidence and all new synthetic engineering inputs. Original generated budget capture is committed to satisfy candidate commit-source equality. Existing unrelated dirty evidence is preserved.','inputCount':f['inputCount'],'auxiliaryInputs':[ref(ROOT/n) for n in aux],'engineering':ref(OUT/'checks-run/summary.json')},indent=2)+'\n');subprocess.run(['corepack','pnpm','exec','prettier','--write',str(record)],cwd=ROOT,check=True);paths.add(str(record.relative_to(ROOT)))
assert not paths.intersection(f['protected'])
selected=[ref(ROOT/n) for n in sorted(paths)]
with (OUT/'source-stage-plan.json').open('x') as h:json.dump({'base':'a07392822ec6a0beaa7e2508ac9fc8ee7795d83d','files':selected,'count':len(selected)},h,indent=2);h.write('\n')
with (OUT/'source-stage-paths.nul').open('xb') as h:h.write(b'\0'.join(n.encode() for n in sorted(paths))+b'\0')
print(json.dumps({'files':len(selected),'bytes':sum(r['bytes'] for r in selected),'plan':ref(OUT/'source-stage-plan.json')}))
