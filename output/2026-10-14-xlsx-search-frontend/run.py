import sys,subprocess,datetime,json,pathlib,hashlib
base=pathlib.Path(__file__).parent
name=sys.argv[1];argv=sys.argv[2:];assert argv
start=datetime.datetime.now(datetime.timezone.utc).isoformat()
p=subprocess.run(argv,capture_output=True)
refs={}
for stream in ['stdout','stderr']:
 path=base/(name+'.'+stream+'.log');data=getattr(p,stream);path.write_bytes(data);refs[stream]={'path':str(path),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
(base/(name+'.completed.json')).write_text(json.dumps({'argv':argv,'cwd':str(pathlib.Path.cwd()),'startedAtUtc':start,'completedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'actualExitCode':p.returncode,**refs},indent=2)+'\n')
print(json.dumps({'name':name,'actualExitCode':p.returncode,**refs}));print(p.stdout.decode()[-12000:]);print(p.stderr.decode()[-3000:]);sys.exit(p.returncode)
