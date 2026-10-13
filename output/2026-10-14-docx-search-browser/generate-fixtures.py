from pathlib import Path
from io import BytesIO
import base64
import hashlib
import json
import zipfile

BASE = Path(__file__).parent
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'

def paragraph(text):
    return '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>'

body = '''<w:p><w:r><w:t xml:space="preserve">BODY nee</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>dle literal &lt;img src="https://example.invalid/DOCX"&gt;</w:t></w:r></w:p>
<w:p><w:r><w:t>LEFT</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>HIDDEN_ONLY needle</w:t></w:r><w:r><w:t>RIGHT</w:t></w:r></w:p>
<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>HEADING needle</w:t></w:r></w:p>
<w:tbl><w:tblGrid><w:gridCol w:w="3600"/></w:tblGrid><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>TABLE needle</w:t></w:r></w:p><w:tbl><w:tblGrid><w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>NESTED needle</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>NOTELEFT</w:t><w:footnoteReference w:id="1"/><w:t>NOTERIGHT</w:t><w:endnoteReference w:id="2"/></w:r></w:p>
<w:p><w:r><w:t>PARALEFT</w:t></w:r></w:p><w:p><w:r><w:t>PARARIGHT</w:t></w:r></w:p>
<w:sectPr><w:headerReference w:type="default" r:id="header"/><w:footerReference w:type="default" r:id="footer"/></w:sectPr>'''

parts = {
    '[Content_Types].xml': f'<Types xmlns="{CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + ''.join(f'<Override PartName="/word/{name}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.{kind}+xml"/>' for name, kind in [('document','document.main'),('header1','header'),('footer1','footer'),('footnotes','footnotes'),('endnotes','endnotes')]) + '</Types>',
    '_rels/.rels': f'<Relationships xmlns="{REL}"><Relationship Id="doc" Type="{R}/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': f'<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}</w:body></w:document>',
    'word/_rels/document.xml.rels': f'<Relationships xmlns="{REL}">' + ''.join(f'<Relationship Id="{identity}" Type="{R}/{kind}" Target="{name}.xml"/>' for identity,kind,name in [('header','header','header1'),('footer','footer','footer1'),('footnotes','footnotes','footnotes'),('endnotes','endnotes','endnotes')]) + '</Relationships>',
    'word/header1.xml': f'<w:hdr xmlns:w="{W}">{paragraph("HEADER needle")}</w:hdr>',
    'word/footer1.xml': f'<w:ftr xmlns:w="{W}">{paragraph("FOOTER needle")}</w:ftr>',
    'word/footnotes.xml': f'<w:footnotes xmlns:w="{W}"><w:footnote w:id="1">{paragraph("FOOTNOTE needle")}</w:footnote></w:footnotes>',
    'word/endnotes.xml': f'<w:endnotes xmlns:w="{W}"><w:endnote w:id="2">{paragraph("ENDNOTE needle")}</w:endnote></w:endnotes>',
}

def capture(name, contents):
    stream = BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for key,value in contents.items():
            info = zipfile.ZipInfo(key, date_time=(2026,10,14,0,0,0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info,value.encode())
    raw=stream.getvalue()
    with (BASE/name).open('xb') as output: output.write(raw)
    path='/controlled/'+name
    return {'file':{'root':'/controlled','path':path,'resolvedPath':path,'name':name,'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'version':'controlled-'+name},'entries':list(contents),'parts':[{'name':key,'data':base64.b64encode(value.encode()).decode()} for key,value in contents.items()],'inflatedBytes':sum(len(value.encode()) for value in contents.values())}

captures=[capture('author.docx',parts),capture('second.docx',{key:value.replace('needle','secondterm') for key,value in parts.items()})]
with (BASE/'captures.json').open('x') as output:json.dump(captures,output,indent=2);output.write('\n')
oracle={'scope':'Independently authored synthetic OOXML. Browser uses controlled capture IPC, production Worker and complete App; this is not a native I/O receipt.','authorNeedleCount':8,'authorVisibleContexts':['BODY','HEADING','TABLE','NESTED','HEADER','FOOTER','FOOTNOTE','ENDNOTE'],'negativeTerms':['HIDDEN_ONLY','LEFTRIGHT','NOTELEFTNOTERIGHT','PARALEFTPARARIGHT','continuousLayout','headingLevel'],'secondTermCount':7,'secondNeedleCount':1,'secondBodySplitRunsUnchanged':True,'files':[item['file'] for item in captures]}
with (BASE/'oracle.json').open('x') as output:json.dump(oracle,output,indent=2);output.write('\n')
print(json.dumps({'files':len(captures),'sourceBytes':[item['file']['size'] for item in captures],'expectedMatches':8}))
