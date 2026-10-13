"""Independent, synthetic OOXML and handwritten search oracle; stdlib only.
No Farfold parser, search helper, existing generator, or formula evaluator imported.
"""
import base64, hashlib, io, json, zipfile
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr
from xml.etree import ElementTree as ET
OUT = Path(__file__).parent
MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
def xml(body): return ('<?xml version="1.0" encoding="UTF-8"?>\n'+body+'\n').encode()
def save(name, b):
    with (OUT/name).open('xb') as f: f.write(b)
def js(name, obj): save(name, (json.dumps(obj, ensure_ascii=False, indent=2)+'\n').encode())
def inline(ref,text,style=0): return '<c r="%s" t="inlineStr" s="%s"><is><t xml:space="preserve">%s</t></is></c>'%(ref,style,escape(text))
def sheet(rows,before='',after=''): return xml('<worksheet xmlns="%s" xmlns:r="%s">%s<sheetData>%s</sheetData>%s</worksheet>'%(MAIN,REL,before,rows,after))
def styles():
    xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="1" hidden="1"/></xf>',
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
      '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
      '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>']
    return xml('<styleSheet xmlns="%s"><numFmts count="2"><numFmt numFmtId="164" formatCode=";;;"/><numFmt numFmtId="165" formatCode=";;;;"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5">%s</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'%(MAIN,''.join(xfs)))
def package(sheets,sst=None):
    # Workbook numeric sheetIds deliberately differ from relationship IDs.
    parts={'xl/styles.xml':styles()}; refs=[]; rels=[]; overrides=[('/xl/workbook.xml','sheet.main'),('/xl/styles.xml','styles')]
    for i,(rid,num,name,state,data) in enumerate(sheets,1):
        p='xl/worksheets/sheet%d.xml'%i; parts[p]=data
        refs.append('<sheet name=%s sheetId="%s" state="%s" r:id="%s"/>'%(quoteattr(name),num,state,rid))
        rels.append('<Relationship Id="%s" Type="%s/worksheet" Target="worksheets/sheet%d.xml"/>'%(rid,REL,i))
        overrides.append(('/'+p,'worksheet'))
    rels.append('<Relationship Id="styleRel" Type="%s/styles" Target="styles.xml"/>'%REL)
    if sst:
        parts['xl/sharedStrings.xml']=xml(sst); overrides.append(('/xl/sharedStrings.xml','sharedStrings'))
        rels.append('<Relationship Id="stringRel" Type="%s/sharedStrings" Target="sharedStrings.xml"/>'%REL)
    parts['xl/workbook.xml']=xml('<workbook xmlns="%s" xmlns:r="%s"><workbookPr date1904="0"/><sheets>%s</sheets><definedNames><definedName name="NAME_LABEL_NEVER">NAME_BODY_NEVER</definedName></definedNames><calcPr fullCalcOnLoad="1" forceFullCalc="1"/></workbook>'%(MAIN,REL,''.join(refs)))
    parts['xl/_rels/workbook.xml.rels']=xml('<Relationships xmlns="%s">%s</Relationships>'%(PKG,''.join(rels)))
    parts['_rels/.rels']=xml('<Relationships xmlns="%s"><Relationship Id="office" Type="%s/officeDocument" Target="xl/workbook.xml"/></Relationships>'%(PKG,REL))
    ov=''.join('<Override PartName="%s" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.%s+xml"/>'%(p,t) for p,t in overrides)
    parts['[Content_Types].xml']=xml('<Types xmlns="%s"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>%s</Types>'%(CT,ov))
    return parts
def capture(name,parts):
    b=io.BytesIO()
    with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for n,v in sorted(parts.items()):
            ET.fromstring(v)
            info=zipfile.ZipInfo(n,(2026,10,14,0,0,0)); info.create_system=3; info.external_attr=0o100644<<16; info.compress_type=zipfile.ZIP_DEFLATED
            z.writestr(info,v,compresslevel=9)
    raw=b.getvalue(); save(name,raw)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        assert z.testzip() is None
        assert {n:z.read(n) for n in z.namelist()}==parts
    return {'file':{'root':'/controlled','path':'/controlled/'+name,'resolvedPath':'/controlled/'+name,'name':name,'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'version':'independent-xlsx-v1-'+name},'entries':sorted(parts),'parts':[{'name':n,'data':base64.b64encode(v).decode()} for n,v in sorted(parts.items())],'inflatedBytes':sum(map(len,parts.values()))}
def entries(rows): return [{'sheetId':s,'reference':r,'field':f,'text':t} for s,r,f,t in rows]
def case(name,segments,positives,negatives,**extra):
    return {'file':name,'segments':entries(segments),'searchableUtf8Bytes':sum(len(x[3].encode()) for x in segments),'queries':[{'query':q,'expectedOccurrences':sum(t.lower().count(q.lower()) for _,_,_,t in segments)} for q in positives]+[{'query':q,'expectedOccurrences':0} for q in negatives],**extra}
def main():
    rows='<row r="1">'+''.join([
      '<c r="A1" t="inlineStr"><is><r><t>_x00</t></r><r><t>41_</t></r></is></c>',inline('B1','_x005F_x0042_'),
      '<c r="C1" t="s"><v>1</v></c>','<c r="D1" t="str"><v>_x0043_ &amp; raw</v></c>',
      '<c r="E1"><v>9007199254740993</v></c>','<c r="F1"><v>+0001.2300E+02</v></c>','<c r="G1" t="b"><v>0</v></c>',
      '<c r="H1" t="e"><v>#N/A</v></c>','<c r="I1" t="d"><v>2026-10-14T00:00:00Z</v></c>',
      '<c r="J1" s="4"><v>0</v></c>','<c r="K1" t="inlineStr"><is><r><t>need</t></r><r><t>leDecoded</t></r></is></c>'])+'</row>'
    rows+='<row r="2">'+''.join([
      '<c r="A2" t="str"><f>FORMULALEFT</f><v>CACHERIGHT</v></c>',
      '<c r="B2"><f t="shared" si="7" ref="B2:B3">SHARE_ANCHOR(B3)</f><v>11</v></c>',
      '<c r="C2" t="str"><f>"_x0044_"</f><v>_x0044_</v></c>',
      '<c r="D2"><f>ZERO_FORMULA</f><v>0</v></c>','<c r="E2"><f>MISSING_FORMULA</f></c>',
      '<c r="F2"><f>EMPTY_NUM_FORMULA</f><v/></c>','<c r="G2" t="str"><f>EMPTY_STR_FORMULA</f><v/></c>',
      '<c r="H2" t="str"><v/></c>','<c r="I2"/>',inline('J2','')])+'</row>'
    rows+='<row r="3"><c r="B3"><f t="shared" si="7"/><v>12</v></c></row>'
    rows+='<row r="4">'+inline('A4','CELLLEFT')+inline('B4','CELLRIGHT')+'</row>'
    rows+='<row r="5">'+inline('A5','汉😀é\tline\nnext')+'</row>'
    sst='<sst xmlns="%s" count="2" uniqueCount="2"><si><t>SST_UNUSED_NEVER</t></si><si><t>DECODE _x0041_ &amp; &lt;词&gt; _xD83D__xDE00_ é</t></si></sst>'%MAIN
    first=capture('decoding-fields.xlsx',package([('relDecode','83','SHEET_LABEL_NEVER','visible',sheet(rows))],sst))
    seg=[]
    for r,t in [('A1','_x0041_'),('B1','_x0042_'),('C1','DECODE A & <词> 😀 é'),('D1','C & raw'),('E1','9007199254740993'),('F1','+0001.2300E+02'),('G1','0'),('H1','#N/A'),('I1','2026-10-14T00:00:00Z'),('J1','0'),('K1','needleDecoded')]: seg.append(('relDecode',r,'value',t))
    seg += [('relDecode','A2','formula','FORMULALEFT'),('relDecode','A2','savedCache','CACHERIGHT'),('relDecode','B2','formula','SHARE_ANCHOR(B3)'),('relDecode','B2','savedCache','11'),('relDecode','C2','formula','"_x0044_"'),('relDecode','C2','savedCache','D'),('relDecode','D2','formula','ZERO_FORMULA'),('relDecode','D2','savedCache','0'),('relDecode','E2','formula','MISSING_FORMULA'),('relDecode','F2','formula','EMPTY_NUM_FORMULA'),('relDecode','G2','formula','EMPTY_STR_FORMULA'),('relDecode','B3','savedCache','12'),('relDecode','A4','value','CELLLEFT'),('relDecode','B4','value','CELLRIGHT'),('relDecode','A5','value','汉😀é\tline\nnext')]
    c1=case('decoding-fields.xlsx',seg,['_x0041_','_x0042_','DECODE A & <词> 😀 é','C & raw','9007199254740993','+0001.2300E+02','needleDecoded','SHARE_ANCHOR','"_x0044_"','汉😀é'],['FORMULALEFTCACHERIGHT','CELLLEFTCELLRIGHT','B2:B3','SST_UNUSED_NEVER','SHEET_LABEL_NEVER','NAME_LABEL_NEVER','NAME_BODY_NEVER','FALSE','=FORMULALEFT','1899','1900','_x005F_'],emptyFields=[{'reference':'G2','field':'savedCache','storedEmpty':True},{'reference':'H2','field':'value','storedEmpty':True},{'reference':'J2','field':'value','storedEmpty':True}],missingCaches=['E2','F2'],noStoredValue=['I2'],sharedFollower='B3: no stored formula text; only cache 12',expectedPartial=True)
    scoped='<row r="1">'+''.join(['<c r="A1" s="1"><f>PROTECTED_FORMULA_NEVER</f><v>31</v></c>','<c r="B1" s="2"><f>HIDDEN_FORMAT_NEVER</f><v>33</v></c>','<c r="C1" s="3"><f>UNKNOWN_FORMAT_NEVER</f><v>34</v></c>',inline('D1','PUBLIC_SCOPE'),inline('E1','MERGE_ANCHOR'),inline('F1','MERGE_COVER_NEVER'),inline('G1','CONDITIONAL_NEVER'),inline('H1','PUBLIC_PROTECTED_VALUE',1),'<c r="I1" s="2"><f>HIDDEN_MISSING_NEVER</f></c>'])+'</row>'
    scoped+='<row r="2" hidden="1">'+inline('A2','HIDDEN_ROW_NEVER')+'</row><row r="3">'+inline('Z3','HIDDEN_COLUMN_NEVER')+'</row>'
    after='<mergeCells count="1"><mergeCell ref="E1:F1"/></mergeCells><sheetProtection sheet="1"/><conditionalFormatting sqref="G1"><cfRule type="expression" priority="1"><formula>CONDITIONAL_RULE_NEVER</formula></cfRule></conditionalFormatting>'
    second=capture('scope-barriers.xlsx',package([('relScope','7','SCOPE_SHEET_LABEL_NEVER','visible',sheet(scoped,'<cols><col min="26" max="26" hidden="1"/></cols>',after)),('relOpen','12','OPEN_SHEET_LABEL_NEVER','visible',sheet('<row r="1"><c r="A1" s="1"><f>UNPROTECTED_FORMULA</f><v>32</v></c></row>')),('relHidden','3','HIDDEN_SHEET_LABEL_NEVER','hidden',sheet('<row r="1">'+inline('A1','HIDDEN_SHEET_BODY_NEVER')+'</row>')),('relVeryHidden','18','VERY_HIDDEN_LABEL_NEVER','veryHidden',sheet('<row r="1">'+inline('A1','VERY_HIDDEN_BODY_NEVER')+'</row>'))]))
    c2=case('scope-barriers.xlsx',[('relScope','A1','savedCache','31'),('relScope','D1','value','PUBLIC_SCOPE'),('relScope','E1','value','MERGE_ANCHOR'),('relScope','H1','value','PUBLIC_PROTECTED_VALUE'),('relOpen','A1','formula','UNPROTECTED_FORMULA'),('relOpen','A1','savedCache','32')],['PUBLIC_SCOPE','MERGE_ANCHOR','PUBLIC_PROTECTED_VALUE','UNPROTECTED_FORMULA','31','32'],['PROTECTED_FORMULA_NEVER','HIDDEN_FORMAT_NEVER','UNKNOWN_FORMAT_NEVER','MERGE_COVER_NEVER','CONDITIONAL_NEVER','CONDITIONAL_RULE_NEVER','HIDDEN_MISSING_NEVER','HIDDEN_ROW_NEVER','HIDDEN_COLUMN_NEVER','HIDDEN_SHEET_BODY_NEVER','VERY_HIDDEN_BODY_NEVER','SCOPE_SHEET_LABEL_NEVER','E1:F1'],expectedPartial=True,requiredWarnings=['hiddenCellsOmitted','hiddenFormulasOmitted','unknownVisibility','coveredMergeData','savedFormulaCaches','recalculationRequested'])
    third=capture('hidden-only.xlsx',package([('relOnlyHidden','29','ALL_HIDDEN_LABEL','hidden',sheet('<row r="1">'+inline('A1','ALL_HIDDEN_BODY_NEVER')+'</row>'))]))
    caps=[first,second,third]
    js('captures.json',caps)
    js('oracle.json',{'schema':1,'scope':'Synthetic selected visible saved values/caches and actual stored included formula text only. Handwritten expected text, no production parser or search helper used. Formula/cache order is not an oracle requirement.','cases':[c1,c2,{'file':'hidden-only.xlsx','expectedError':'scopeEmpty','segments':[],'searchableUtf8Bytes':0}],'files':[c['file'] for c in caps],'semantics':['r:id is the existing stable sheet identity; numeric sheetId is not exposed as sheet.id.','ST_Xstring decoding is one pass per original string or rich-text run; formula text is not ST_Xstring-decoded.','Empty saved string is distinguishable from absent numeric cache, but supplies no nonempty searchable segment.','No equals prefix, shared-formula expansion, recomputation, labels, formula attributes, or display generation.','Each field and cell is a separate search segment.','All counts and UTF-8 sizes computed from the handwritten segments only.']})
    frozen={p.name:{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(OUT.iterdir()) if p.is_file()}
    js('fixture-freeze.json',{'phase':'oracle frozen before reading new xlsx search helper','files':frozen,'zipCrcAndXmlParse':'passed stdlib only','productionExecution':False})
    print(json.dumps({'files':len(caps),'cases':[(c['file'],len(c['segments']),c['searchableUtf8Bytes']) for c in [c1,c2]],'fixtureFreezeSha256':hashlib.sha256((OUT/'fixture-freeze.json').read_bytes()).hexdigest()}))
if __name__=='__main__': main()
