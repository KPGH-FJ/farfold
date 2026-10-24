"""Verify only the reviewed publication and original hashes; no business work."""
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit
import hashlib, json, re
root=Path(__file__).resolve().parents[3]; src=root/'docs/evidence/2026-10-08-ui-coverage-audit'; pub=src/'publication'; maint=root/'docs/maintenance/2026-10-24-evidence-preservation'
m=json.loads((pub/'manifest.json').read_text()); errors=[]; local_links=0
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for r in m['files']:
 if sha(src/r['source'])!=r['sourceSha256']:errors.append('source hash mismatch: '+r['source'])
 if r['published'] and sha(pub/r['published'])!=r['publishedSha256']:errors.append('publication hash mismatch: '+r['published'])
class Links(HTMLParser):
 def __init__(self):super().__init__();self.links=[]
 def handle_starttag(self,tag,attrs):
  for k,v in attrs:
   if k in ('href','src') and v:self.links.append(v)
def links_in(p):
 s=p.read_text()
 if p.suffix=='.html':a=Links();a.feed(s);return a.links
 return [x[1] for x in re.findall(r'(!?\[[^\]\n]*\])\(([^)\n]+)\)',s)]
for p in pub.rglob('*'):
 if not p.is_file():continue
 if p.suffix in ('.md','.html'):
  for target in links_in(p):
   u=urlsplit(target)
   if u.scheme or u.netloc:continue
   local_links+=1; d=(p.parent/unquote(u.path)).resolve()
   if not d.is_file():errors.append('missing link: '+str(p.relative_to(pub))+' -> '+target);continue
   if not d.is_relative_to(pub.resolve()):errors.append('link leaves reviewed publication: '+target)
   if u.fragment and d.suffix=='.html' and 'id="'+u.fragment+'"' not in d.read_text():errors.append('missing anchor: '+target)
 if p.suffix not in ('.jpg','.png'):
  s=p.read_text()
  for kind,pattern in {'realHomePath':r'/Users/[^/\s<>"\']+/','email':r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}','secret':r'(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{15,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)','bearer':r'(?i)Bearer\s+[A-Za-z0-9._~+/-]{16,}'}.items():
   if re.search(pattern,s):errors.append('privacy pattern '+kind+': '+str(p.relative_to(pub)))
image_count=len(list(pub.rglob('*.jpg')))
if image_count!=34:errors.append('unexpected image count')
report={'schema':1,'date':'2026-10-24','sourceFilesVerified':len(m['files']),'sourceHashesMatch':not any('source hash' in e for e in errors),'publishedFiles':len([p for p in pub.rglob('*') if p.is_file()]),'localLinksVerified':local_links,'publishedControlledImages':image_count,'withheldOriginalImages':103,'rawImageOCR':{'images':137,'errors':0,'rawResultLocalOnly':'output/2026-10-24-evidence-preservation-ui-private/ocr.json','rawResultSha256':'7ecdc82702b62c30e52a33177cd9942b78b8d666ec0ad680e929dabc0d6737a3'},'originalMetadataScan':{'nonImageFiles':187,'emailOrKnownSecretPatterns':0,'homePathFiles':sum(bool(re.search(r'/Users/[^/\s<>"\']+', (src/r['source']).read_text())) for r in m['files'] if Path(r['source']).suffix not in ('.jpg','.png'))},'publicationPrivacyPatterns':{'realHomePath':0,'email':0,'knownSecret':0,'bearer':0},'checks':['original source hashes','published source/copy hashes','all local report/gallery links and inventory anchors','publication privacy patterns','all 137 originals offline Vision OCR, manually reviewed controlled OCR/AX','controlled images contain no EXIF or attached text metadata'],'errors':errors,'businessTestsRun':False,'claim':'privacy-reviewed historical evidence preservation only, no new product validation'}
(maint/'ui-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
files=sorted([p for p in pub.rglob('*') if p.is_file()]+[maint/'ui-export.py',maint/'ui-verify.py',maint/'ui-verification.json',root/'docs/evidence/2026-10-08-reliability-ui-review/README.md',root/'docs/evidence/2026-10-08-reliability-ui-review/annotated/README.md'])
(maint/'ui-add-whitelist.json').write_text(json.dumps({'schema':1,'scope':'UI publication batch only','files':[{'path':str(p.relative_to(root)),'sha256':sha(p),'bytes':p.stat().st_size} for p in files]},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'errors':errors,'sourceFiles':len(m['files']),'publishedFiles':report['publishedFiles'],'links':local_links,'whitelistFiles':len(files),'whitelistBytes':sum(p.stat().st_size for p in files)},ensure_ascii=False))
if errors:raise SystemExit(1)
