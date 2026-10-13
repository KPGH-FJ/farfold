"""Independent source XML/capture and handwritten-oracle verification; no production code."""
import base64, hashlib, json, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
R=Path('/Users/tw/Desktop/farfold'); O=Path(__file__).parent
B=R/'output/2026-10-14-xlsx-search-browser'
M='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
REL='{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
def pin(p):
    b=p.read_bytes(); return {'path':str(p.relative_to(R)),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def capture_check(directory,c):
    p=directory/c['file']['name']; raw=p.read_bytes()
    assert len(raw)==c['file']['size'] and hashlib.sha256(raw).hexdigest()==c['file']['sha256']
    with zipfile.ZipFile(p) as z:
        assert z.testzip() is None
        assert set(z.namelist())==set(c['entries']) and len(z.namelist())==len(c['entries'])
        assert sum(i.file_size for i in z.infolist())==c['inflatedBytes']
        assert {i['name']:base64.b64decode(i['data'],validate=True) for i in c['parts']}=={n:z.read(n) for n in z.namelist() if n.endswith(('.xml','.rels'))}
        for n in z.namelist():
            if n.endswith(('.xml','.rels')): ET.fromstring(z.read(n))
    return pin(p)
rootcaps=json.loads((B/'captures.json').read_text()); budgetcaps=json.loads((B/'budget-captures.json').read_text())
checked=[capture_check(B,c) for c in rootcaps+budgetcaps]
manual=[('rId1','A1','value','needle 汉😀é'),('rId1','B1','value','12345678901234567890.000100'),('rId1','C1','value','0'),('rId1','D1','value','#DIV/0!'),('rId1','E1','value','2026-10-14T00:00:00Z'),('rId1','F1','formula','"needle formula-only"'),('rId1','F1','savedCache','needle cached-result'),('rId1','G1','value','LEFT'),('rId1','H1','value','RIGHT'),('rId1','I1','formula','NO_CACHE_FORMULA'),('rId1','J1','formula','EMPTY_CACHE_FORMULA'),('rId1','K1','formula','0'),('rId1','K1','savedCache','0'),('rId1','L1','savedCache','8'),('rId1','A5','value','needle <img src="https://example.invalid/XLSX">'),('rId2','A1','value','second sheet needle')]
rootoracle=json.loads((B/'oracle.json').read_text())
assert rootoracle['segments']==[dict(zip(['sheetId','reference','field','text'],r)) for r in manual]
assert sum(len(t.encode()) for *_,t in manual)==rootoracle['authorBytes']==226
assert sum(t.count('needle') for *_,t in manual)==rootoracle['authorNeedleCount']==5
assert all(not any(q in t for *_,t in manual) for q in rootoracle['negativeTerms'])
with zipfile.ZipFile(B/'author.xlsx') as z:
    workbook=ET.fromstring(z.read('xl/workbook.xml')); sheets=workbook.find(M+'sheets')
    assert [(s.attrib['sheetId'],s.attrib[REL+'id']) for s in sheets]==[('17','rId1'),('3','rId2'),('91','rId3')]
    sheet=ET.fromstring(z.read('xl/worksheets/sheet1.xml')); cells={c.attrib['r']:c for c in sheet.iter(M+'c')}
    assert [t.text for t in ET.fromstring(z.read('xl/sharedStrings.xml')).iter(M+'t')]==['nee','dle 汉😀é']
    for addr,raw in [('A1','0'),('B1','12345678901234567890.000100'),('C1','0'),('D1','#DIV/0!'),('E1','2026-10-14T00:00:00Z'),('F1','needle cached-result'),('K1','0'),('L1','8')]: assert cells[addr].find(M+'v').text==raw
    for addr,formula in [('F1','"needle formula-only"'),('I1','NO_CACHE_FORMULA'),('J1','EMPTY_CACHE_FORMULA'),('K1','0')]: assert cells[addr].find(M+'f').text==formula
    assert cells['I1'].find(M+'v') is None and cells['J1'].find(M+'v').text is None
    assert cells['L1'].find(M+'f').text is None and cells['L1'].find(M+'f').attrib=={'t':'shared','si':'4'}
    assert sheet.find(M+'cols')[0].attrib=={'min':'26','max':'26','hidden':'1'}
    assert sheet.find(M+'sheetData')[1].attrib=={'r':'2','hidden':'1'}
    assert ''.join(t.text or '' for t in cells['A5'].iter(M+'t'))==manual[-2][-1]
with zipfile.ZipFile(B/'author.xlsx') as a,zipfile.ZipFile(B/'second.xlsx') as b:
    assert a.namelist()==b.namelist()
    assert all(b.read(n)==a.read(n).replace(b'needle',b'secondterm') for n in a.namelist())
    # Split rich-run needle remains; four contiguous original source strings change.
    assert sum(a.read(n).count(b'needle') for n in a.namelist())==4
budgetoracle=json.loads((B/'budget-oracle.json').read_text())
for name in ['budget-a.xlsx','budget-b.xlsx']:
    with zipfile.ZipFile(B/name) as z:
        s=ET.fromstring(z.read('xl/worksheets/sheet1.xml')); ts=list(s.iter(M+'t'))
        assert len(ts)==1 and ts[0].text=='汉'*3_000_000+' needle'
        assert len(ts[0].text.encode())==9_000_007==budgetoracle['authorUtf8BytesPerFile']
        assert (B/name).stat().st_size<1024*1024
owncaps=json.loads((O/'captures.json').read_text()); own=[capture_check(O,c) for c in owncaps]
ownoracle=json.loads((O/'oracle.json').read_text())
for c in ownoracle['cases']:
    seg=c['segments']; assert sum(len(s['text'].encode()) for s in seg)==c['searchableUtf8Bytes']
    for q in c.get('queries',[]): assert sum(s['text'].lower().count(q['query'].lower()) for s in seg)==q['expectedOccurrences']
freeze=json.loads((O/'fixture-freeze.json').read_text())
assert all(pin(O/n)['sha256']==v['sha256'] and pin(O/n)['bytes']==v['bytes'] for n,v in freeze['files'].items())
report={'schema':1,'result':'passed','scope':'Independent static synthetic XML/capture/oracle review. No production search/parser/Worker/native/App execution.','root':{'checkedArchives':checked,'oracle':pin(B/'oracle.json'),'generator':pin(B/'generate-fixtures.py'),'authorSegments':16,'authorUtf8Bytes':226,'authorNeedleMatches':5,'secondNeedleMatches':1,'secondSecondtermMatches':4,'budgetUtf8PerWorkbook':9000007,'sheetIdentityCorrection':'Current rId1/rId2 oracle is correct. Original numeric sheetId assumption was an oracle error, not a product defect; original root records retained.'},'independent':{'freeze':pin(O/'fixture-freeze.json'),'archives':own,'cases':[{'file':c['file'],'segments':len(c['segments']),'utf8Bytes':c['searchableUtf8Bytes'],'expectedError':c.get('expectedError')} for c in ownoracle['cases']]},'boundaries':['Expected strings were authored independently and not computed by the implementation under test.','ZIP CRC, full byte hashes, every captured part, entry membership, inflated counts and XML well-formedness checked.','No formula evaluation/shared expansion/display generation; no real Agent claims.','Real Worker search and actual IPC remain root/owner verification scopes.']}
with (O/'fixture-static-review.json').open('x') as f: json.dump(report,f,ensure_ascii=False,indent=2); f.write('\n')
print(json.dumps({'result':'passed','review':pin(O/'fixture-static-review.json')}))
