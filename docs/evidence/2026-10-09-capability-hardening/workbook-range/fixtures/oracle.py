"""Independent ZIP/XML rectangle facts. No Farfold or writer imports.

This records geometry and hidden metadata, not future product accept/reject
behavior. The derivative is explicitly authored test XML, not ordinary output.
"""
from pathlib import Path
from io import BytesIO
from xml.dom import minidom
import datetime
import hashlib
import json
import re
import zipfile
import xml.etree.ElementTree as ET

OUT = Path(__file__).resolve().parent
NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
Q = '{' + NS + '}'
sha = lambda raw: hashlib.sha256(raw).hexdigest()

def point(value):
    m = re.fullmatch(r'([A-Z]{1,3})([1-9][0-9]{0,6})', value)
    assert m, value
    col = 0
    for letter in m[1]:
        col = col * 26 + ord(letter) - 64
    row = int(m[2])
    assert row <= 1048576 and col <= 16384, value
    return row, col

def rectangle(value):
    ends = value.split(':')
    assert len(ends) in [1, 2]
    a, b = point(ends[0]), point(ends[-1])
    return {'fromRow': min(a[0], b[0]), 'toRow': max(a[0], b[0]),
            'fromColumn': min(a[1], b[1]), 'toColumn': max(a[1], b[1])}

def contains(a, b):
    return a['fromRow'] <= b['fromRow'] <= b['toRow'] <= a['toRow'] and a['fromColumn'] <= b['fromColumn'] <= b['toColumn'] <= a['toColumn']

def intersection(a, b):
    r = {'fromRow': max(a['fromRow'], b['fromRow']), 'toRow': min(a['toRow'], b['toRow']),
         'fromColumn': max(a['fromColumn'], b['fromColumn']), 'toColumn': min(a['toColumn'], b['toColumn'])}
    return r if r['fromRow'] <= r['toRow'] and r['fromColumn'] <= r['toColumn'] else None

RANGES = ['B3:G6', 'W98:AB103', 'C8:F9', 'D8:E8', 'B7:G10', 'Z101:AC103',
          'B20:E24', 'E24:B20', 'XFC1048575:XFD1048576', 'XFD1048576',
          'A1:XFD1048576', 'AD105:AE106']

def inspect(path):
    raw = path.read_bytes()
    with zipfile.ZipFile(BytesIO(raw)) as z:
        assert z.testzip() is None
        assert len(set(z.namelist())) == len(z.namelist())
        wb = ET.fromstring(z.read('xl/workbook.xml'))
        relationships = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        mapping = {e.attrib['Id']: e.attrib['Target'] for e in relationships}
        sheets = []
        for info in wb.find(Q + 'sheets'):
            rid = info.attrib['{' + REL + '}id']
            target = mapping[rid]
            part = target.lstrip('/') if target.startswith('/') else 'xl/' + target
            xml = z.read(part)
            root = ET.fromstring(xml)
            cells = {}
            for cell in root.findall('./' + Q + 'sheetData/' + Q + 'row/' + Q + 'c'):
                address = cell.attrib['r']
                row, col = point(address)
                val, formula = cell.find(Q + 'v'), cell.find(Q + 'f')
                cells[address] = {'row': row, 'column': col, 'type': cell.get('t'),
                                  'rawValue': None if val is None else val.text,
                                  'valueNode': val is not None, 'formula': None if formula is None else formula.text}
            merges = {x.attrib['ref']: rectangle(x.attrib['ref']) for x in root.findall('./' + Q + 'mergeCells/' + Q + 'mergeCell')}
            hidden_rows = [int(x.attrib['r']) for x in root.findall('./' + Q + 'sheetData/' + Q + 'row') if x.get('hidden') == '1']
            hidden_cols = [{'min': int(x.attrib['min']), 'max': int(x.attrib['max'])} for x in root.findall('./' + Q + 'cols/' + Q + 'col') if x.get('hidden') == '1']
            # A second XML implementation checks every address, value and merge.
            dom = minidom.parseString(xml)
            dom_cells = dom.getElementsByTagNameNS(NS, 'c')
            assert len(dom_cells) == len(cells)
            for node in dom_cells:
                address = node.getAttribute('r'); values = node.getElementsByTagNameNS(NS, 'v')
                assert cells[address]['valueNode'] == bool(values)
                assert (''.join(c.data for c in values[0].childNodes if c.nodeType in [c.TEXT_NODE, c.CDATA_SECTION_NODE]) or None if values else None) == cells[address]['rawValue']
            assert {x.getAttribute('ref') for x in dom.getElementsByTagNameNS(NS, 'mergeCell')} == set(merges)
            dom.unlink()
            facts = []
            for address in RANGES:
                rect = rectangle(address)
                hits = [{'merge': name, 'fullMerge': bounds, 'intersection': intersection(rect, bounds),
                         'fullyContained': contains(rect, bounds)} for name, bounds in merges.items() if intersection(rect, bounds)]
                hr = [r for r in hidden_rows if rect['fromRow'] <= r <= rect['toRow']]
                hc = [c for c in hidden_cols if c['min'] <= rect['toColumn'] and c['max'] >= rect['fromColumn']]
                populated = [name for name, c in cells.items() if rect['fromRow'] <= c['row'] <= rect['toRow'] and rect['fromColumn'] <= c['column'] <= rect['toColumn'] and (c['rawValue'] is not None or c['formula'] is not None)]
                facts.append({'input': address, 'normalized': rect,
                              'areaArithmeticOnly': (rect['toRow']-rect['fromRow']+1)*(rect['toColumn']-rect['fromColumn']+1),
                              'crossesFirst100RowWindow': rect['fromRow'] <= 100 < rect['toRow'],
                              'crossesFirst24ColumnWindow': rect['fromColumn'] <= 24 < rect['toColumn'],
                              'merges': hits, 'partialMerges': [x['merge'] for x in hits if not x['fullyContained']],
                              'hiddenRowsIntersecting': hr, 'hiddenColumnsIntersecting': hc,
                              'storedValueOrFormulaCells': populated,
                              'interpretation':'Structural facts only; no acceptance policy or rendered-read proof.'})
            sheets.append({'name':info.attrib['name'],'relationshipId':rid,'sheetIdAttribute':info.attrib['sheetId'],
                           'state':info.get('state','visible'),'part':part,'partSha256':sha(xml),
                           'cells':cells,'merges':merges,'hiddenRows':hidden_rows,'hiddenColumns':hidden_cols,'ranges':facts})
    return {'file':path.name,'sha256':sha(raw),'bytes':len(raw),'zipCrcAllPassed':True,'sheets':sheets}

def derive(base):
    with zipfile.ZipFile(BytesIO(base)) as z:
        infos = z.infolist(); parts = {x.filename:z.read(x.filename) for x in infos}
    wb = ET.fromstring(parts['xl/workbook.xml'])
    old_ids = [x.attrib['{' + REL + '}id'] for x in wb.find(Q+'sheets')]
    ids = ['sheet-main-A9', 'sheet-other-17']
    for old,new in zip(old_ids,ids):
        for name,attr in [('xl/workbook.xml','r:id'),('xl/_rels/workbook.xml.rels','Id')]:
            needle=(attr+'="'+old+'"').encode();assert parts[name].count(needle)==1
            parts[name]=parts[name].replace(needle,(attr+'="'+new+'"').encode())
    parts['xl/workbook.xml']=parts['xl/workbook.xml'].replace(b'sheetId="1"',b'sheetId="17"').replace(b'sheetId="2"',b'sheetId="4"')
    for name in ['xl/worksheets/sheet1.xml','xl/worksheets/sheet2.xml']:
        raw=parts[name]
        for row in [22,100]:
            needle=('<x:row r="'+str(row)+'"').encode();assert raw.count(needle)==1
            raw=raw.replace(needle,needle+b' hidden="1"')
        for column in [4,25]:
            pattern=rb'(<x:col min="'+str(column).encode()+rb'"[^>]*?)hidden="0"'
            raw,n=re.subn(pattern,rb'\1hidden="1"',raw);assert n==1
        parts[name]=raw
    buf=BytesIO()
    with zipfile.ZipFile(buf,'w') as z:
        for info in infos:z.writestr(info,parts[info.filename])
    return buf.getvalue(),dict(zip(old_ids,ids))

def main():
    base=OUT/'range-layout.xlsx'; before=sha(base.read_bytes()); derivative,mapping=derive(base.read_bytes())
    target=OUT/'range-nonordinal-hidden.xlsx'
    if target.exists():assert target.read_bytes()==derivative
    else:target.write_bytes(derivative)
    inspected=[inspect(base),inspect(target)]
    assert sha(base.read_bytes())==before
    for f in inspected:
        for s in f['sheets']:
            assert s['cells']['A2']['type']=='n' and s['cells']['A2']['rawValue']=='0'
            assert s['cells']['B2']['type']=='b' and s['cells']['B2']['rawValue']=='0'
            assert s['cells']['F2']['formula']=='1+1' and s['cells']['F2']['rawValue']=='2'
            assert s['merges']['X99:AA102']=={'fromRow':99,'toRow':102,'fromColumn':24,'toColumn':27}
            far=next(x for x in s['ranges'] if x['input']=='XFC1048575:XFD1048576')
            assert far['areaArithmeticOnly']==4 and not far['storedValueOrFormulaCells'] and not far['merges']
            assert next(x for x in s['ranges'] if x['input']=='D8:E8')['partialMerges']==['C8:F9']
    for s in inspected[1]['sheets']:
        f=next(x for x in s['ranges'] if x['input']=='B20:E24')
        assert f['hiddenRowsIntersecting']==[22] and f['hiddenColumnsIntersecting']==[{'min':4,'max':4}]
    result={'createdAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'method':'stdlib ZIP CRC + ElementTree geometry; minidom independently checks all stored cells and merge refs. No Farfold parser/Worker/app, no openpyxl writer readback.','writerBase':'bundled @oai/artifact-tool; unchanged export bytes','controlledDerivative':{'file':target.name,'from':base.name,'relationshipMapping':mapping,'modifications':['Two r:id and matching relationships remapped to named nonordinal IDs; sheetId attributes17 and4 are distinct from tab order/relationship id.','Only row22/100 and columnD/Y hidden flags added in both sheets.'],'notOrdinaryWriterOutput':True},'files':inspected,'semanticStatus':'geometry_only_pending_product_policy_confirmation','limits':['No XLSX parser or new rectangle capability was executed. Generated samples can expose writer compatibility differences; do not silently rewrite them to pass.','No full-grid allocation or enumeration: inspect only stored XML cells and merge metadata; huge legal rectangle area calculated arithmetically.','Artifact-tool renderer previews are writer-engine views, not Farfold/Excel/native proof.','Hidden cells remain in the ZIP by design; hiding is display behavior, not removal or secrecy.']}
    (OUT/'oracle.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'files':2,'sheets':4,'ranges':sum(len(s['ranges']) for f in inspected for s in f['sheets']),'allCrcAndLiteralAssertions':'passed','hashes':{f['file']:f['sha256'] for f in inspected},'productTestsRun':False},ensure_ascii=False))

if __name__=='__main__':main()
