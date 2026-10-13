from pathlib import Path
from io import BytesIO
import base64
import hashlib
import json
import zipfile

base=Path(__file__).parent
text='\u754c'*3_000_000+' needle'
parts={
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'+text+'</w:t></w:r></w:p></w:body></w:document>',
}
stream=BytesIO()
with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_DEFLATED) as archive:
    for name,value in parts.items():
        info=zipfile.ZipInfo(name,date_time=(2026,10,14,0,0,0))
        info.compress_type=zipfile.ZIP_DEFLATED
        archive.writestr(info,value.encode())
raw=stream.getvalue();captures=[]
for name in ('budget-a.docx','budget-b.docx'):
    (base/name).write_bytes(raw)
    path='/controlled/'+name
    captures.append({'file':{'root':'/controlled','path':path,'resolvedPath':path,'name':name,'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'version':'controlled-'+name},'entries':list(parts),'parts':[{'name':key,'data':base64.b64encode(value.encode()).decode()} for key,value in parts.items()],'inflatedBytes':sum(len(value.encode()) for value in parts.values())})
(base/'budget-captures.json').write_text(json.dumps(captures)+'\n')
(base/'budget-oracle.json').write_text(json.dumps({'scope':'Independent literal 3,000,000 CJK characters plus one ASCII query; each valid three-part DOCX archive is below 1MiB but expanded author text is over 8MiB.','sourceBytesEach':len(raw),'authorUtf8BytesEach':len(text.encode()),'query':'needle','matchesEach':1,'twoExceed16MiB':len(text.encode())*2>16*1024*1024,'sourceHash':hashlib.sha256(raw).hexdigest()},indent=2)+'\n')
print(json.dumps({'sourceBytesEach':len(raw),'authorUtf8BytesEach':len(text.encode()),'inputJsonBytes':(base/'budget-captures.json').stat().st_size}))
