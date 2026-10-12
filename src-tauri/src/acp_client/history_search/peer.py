# Synthetic official-peer surface; does not read any Agent history or config.
import sys,json,os,time
mode,cwd=sys.argv[1:]
page=0
for line in sys.stdin:
 r=json.loads(line);m=r['method']
 assert m in ('initialize','initialized','thread/read','thread/turns/list'),m
 if m=='initialized':continue
 if m=='initialize':v={'userAgent':'owned-synthetic'}
 elif m=='thread/read':
  assert r['params']=={'threadId':'native-1','includeTurns':False}
  v={'thread':{'id':'wrong' if mode=='wrong' else 'native-1','cwd':cwd}}
 else:
  assert r['params']['threadId']=='native-1' and r['params']['itemsView']=='full'
  if mode=='unsupported':
   print(json.dumps({'id':r['id'],'error':{'code':-32601,'message':'synthetic unsupported'}}),flush=True);continue
  if mode=='malformed':
   print(json.dumps({'id':r['id'],'error':{'message':'missing code'}}),flush=True);continue
  page+=1
  if mode=='hold' and page==2:
   open(os.path.join(cwd,'read-ready'),'w').close()
   until=time.monotonic()+5
   while not os.path.exists(os.path.join(cwd,'release-read')) and time.monotonic()<until:time.sleep(.01)
  if mode=='many':items=[{'id':f'u-{i}','type':'agentMessage','text':'hello'} for i in range(240)]
  elif mode=='split':items=[{'id':'split','type':'userMessage','content':[{'type':'text','text':'hel'},{'type':'text','text':'lo'}]}]
  else:items=[{'id':'u-1','type':'userMessage','content':[{'type':'image','url':'not-read'},{'type':'text','text':'😀 Hello source'},{'type':'text','text':'unmatched'}]},{'id':'a-1','type':'agentMessage','text':'HELLO reply'}]
  data=[{'id':f'turn-{page}','itemsView':'summary' if mode=='summary' else 'full','items':items}]
  if page==2 and mode!='repeat':data=[]
  v={'data':data,'nextCursor':'next' if mode=='repeat' or (page==1 and mode in ('normal','hold')) else None,'backwardsCursor':None}
 if mode=='drift' and m=='thread/turns/list':
  os.rename(cwd,cwd+'.original');os.mkdir(cwd)
 print(json.dumps({'id':r['id'],'result':v},ensure_ascii=False),flush=True)
