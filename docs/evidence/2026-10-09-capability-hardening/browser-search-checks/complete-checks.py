"""Close the one test-only formatting correction without repeating unaffected suites."""
from pathlib import Path
import runpy,sys,json,datetime,hashlib,subprocess
OUT=Path(__file__).resolve().parent
sys.argv=[str(OUT/'run-checks.py')]
m=runpy.run_path(sys.argv[0]); ROOT=m['ROOT']; sha=m['sha']; ref=m['ref']; write=m['write']; execute=m['execute']
current=m['collector'](); assert m['protect']()
changed='src/runtime/loaded_search_dom.test.tsx'
front=json.loads((OUT/'frontend-final/frontend-inputs.json').read_text())
assert {p for p in current.keys()|front.keys() if current.get(p)!=front.get(p)}=={changed}
before_file=OUT/'loaded_search_dom.test.tsx.before-format.txt'
assert sha(before_file)==front[changed]
assert json.loads((OUT/'rust-final/rust-inputs.json').read_text())==m['inputs']('rust')
if (OUT/'inputs-final.json').exists(): assert json.loads((OUT/'inputs-final.json').read_text())==current
else: write('inputs-final.json',current)
program="""const fs=require('fs'),ts=require('typescript');
const parse=s=>ts.createSourceFile('same.tsx',s,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const tree=sf=>{if(sf.parseDiagnostics.length)throw Error('Parse error');const visit=n=>{const children=[];ts.forEachChild(n,c=>{children.push(visit(c))});return [n.kind,children.length?children:n.getText(sf)]};return JSON.stringify(visit(sf))};
const a=fs.readFileSync(process.argv[1],'utf8'),b=fs.readFileSync(process.argv[2],'utf8');
const left=parse(a),right=parse(b);if(tree(left)!==tree(right))throw Error('test syntax changed');
const printer=ts.createPrinter();console.log(JSON.stringify({syntaxTreeAndLeafTextEqual:true,printerOutputEqual:printer.printFile(left)===printer.printFile(right),qualification:'Printer preserves original line layout and is not an AST equality check. Prior printer rejection retained.'}));"""
equivalence=execute('test-format-ast-equivalence',['node','-e',program,str(before_file),changed]); assert equivalence['exitCode']==0
targeted=execute('test-format-targeted',['corepack','pnpm','exec','vitest','run',changed]); assert targeted['exitCode']==0
checks=[]
for kind in ('rust','frontend'):
 d=json.loads((OUT/(kind+'-final')/(kind+'-verification.json')).read_text());assert d['allPassed']
 for c in d['checks']:
  assert sha(ROOT/c['log'])==c['sha256']; c={**c,'executedInThisRun':False,'reuseBasis':'Exact current Rust inputs' if kind=='rust' else 'All application inputs unchanged; one test whitespace-only correction has identical TypeScript syntax tree and leaf text plus targeted rerun'};checks.append(c)
checks.append(execute('format-final',['corepack','pnpm','format:check']));checks[-1]['name']='format'
after=m['collector']();write('inputs-final-after.json',after)
old=json.loads((OUT/'final-verification-first-format-failure.json').read_text())
record={'checkedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceBase':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'inputCount':len(current),'sourceStable':current==after,'protectedUnchanged':m['protect'](),'inputsBefore':ref(OUT/'inputs-final.json'),'inputsAfter':ref(OUT/'inputs-final-after.json'),'checks':checks,'counts':old['counts'],'sourceClosure':ref(OUT/'source-closure.json'),'testFormattingFollowup':{'path':changed,'beforeSha256':front[changed],'afterSha256':current[changed],'equivalence':equivalence,'targeted':targeted},'priorFailedAggregate':ref(OUT/'final-verification-first-format-failure.json'),'priorRuns':old['priorRuns'],'allPassed':current==after and m['protect']() and all(c['exitCode']==0 for c in checks),'boundary':'Seven required checks have passing evidence. Final format and affected test rerun executed here; existing full tests/type/build reused only for identical production inputs and syntax-identical test reformat. Prior Rust failures remain unlocalized, not erased. No installed, real-Agent or Windows claim.'}
write('final-verification.json',record)
print(json.dumps({'allPassed':record['allPassed'],'counts':record['counts'],'inputCount':len(current)}),flush=True)
raise SystemExit(0 if record['allPassed'] else 1)
